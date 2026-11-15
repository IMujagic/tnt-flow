#!/usr/bin/env node
// PreToolUse guard. Keeps evidence tamper-proof and steps independent:
//  1. Nobody writes harness-owned files (ledgers, state, evidence, reports)
//     except through the tnt CLI.
//  2. Once the red gate passes, locked test files are read-only until the
//     orchestrator runs `tnt unlock`.
//  3. Verifier subagents may only write their own draft files.
//  4. Subagents never run the orchestrator's or the human's tnt commands
//     (gate, approve, waive, unlock, sync, start, init), never import the
//     harness directly, and never run git commands that rewrite history,
//     move branches or discard changes.
//  5. In the main session, approve, waive, unlock and sync --relock go to a
//     Claude Code permission prompt, so a person confirms every human decision.
// Exit 2 blocks the tool call; stderr is shown to the model. A JSON
// `permissionDecision: "ask"` on stdout (exit 0) makes Claude Code ask the user.
import fs from 'node:fs';
import path from 'node:path';

const TNT = '.tnt';
const PROTECTED = [
  /^\.tnt\/ledger\.jsonl$/, // the single ledger of tnt 0.1
  /^\.tnt\/(active\.json|view\.html)$/,
  /^\.tnt\/evidence\//,
  /^\.tnt\/_project\/(ledger\.jsonl$|evidence\/)/,
  /^\.tnt\/features\/[^/]+\/(ledger\.jsonl|state\.json|report\.md)$/,
  /^\.tnt\/features\/[^/]+\/evidence\//,
  /^\.tnt\/reviews\/[^/]+\/(ledger\.jsonl|state\.json|report\.md)$/,
  /^\.tnt\/reviews\/[^/]+\/evidence\//,
];
// Agents that may write only these files (verifiers, and the claims analyst of a review).
const VERIFIER_WRITABLE = {
  'code-reviewer': [/^\.tnt\/(features|reviews)\/[^/]+\/review\.draft\.json$/],
  'evidence-auditor': [/^\.tnt\/(features|reviews)\/[^/]+\/audit\.draft\.json$/],
  'functional-tester': [/^\.tnt\/(features|reviews)\/[^/]+\/functional\//],
  'style-verifier': [],
  'claims-analyst': [/^\.tnt\/reviews\/[^/]+\/spec\.md$/],
};
const LOCK_PHASES = new Set(['red', 'green', 'style', 'review', 'functional', 'audit', 'done']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// A command "writes" if it has a shell redirect outside quotes (so `=>`, `>=`
// and "a > b" inside node -e / echo strings don't count), or uses a
// write-capable command or API anywhere.
const WRITE_WORDS = /\btee\b|\bcp\b|\bmv\b|\brm\b|\binstall\b|\bln\b|\bgit\s+(checkout|restore|stash|reset)\b|\bsed\s+-i|\bperl\s+-[a-z]*i|\btruncate\b|\bdd\b|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Clear-Content|New-Item|writeFile|appendFile|createWriteStream|copyFile|rename(Sync)?\(|unlink|open\([^)]*['"][wa]/i;
function writes(cmd) {
  const unquoted = cmd
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/\d?>&\d|&>\s*\/dev\/null/g, '')
    .replace(/\d?>\s*(\/dev\/null|\$null|nul)\b/gi, '');
  return />/.test(unquoted) || WRITE_WORDS.test(cmd);
}
const unquote = (cmd) => cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ');

// tnt subcommands that decide gates or record human decisions. `TNT check` is
// the subagents' dry run; everything here belongs to the orchestrator or a person.
const TNT_CALL = /\btnt(?:\.mjs)?["']?\s+([a-z-]+)([^;&|\n]*)/g;
const ORCHESTRATOR_ONLY = new Set(['gate', 'approve', 'waive', 'unlock', 'sync', 'start', 'init']);
const HARNESS_IMPORT = /scripts\/lib\/(harness|core|view)\.mjs/;
function humanDecision(cmd) {
  for (const [, sub, rest] of cmd.matchAll(TNT_CALL)) {
    if (sub === 'approve' || sub === 'waive' || sub === 'unlock') return sub;
    if (sub === 'sync' && /--relock\b/.test(rest)) return 'sync --relock';
  }
  return null;
}

// git subcommands a step never needs: the harness commits, the orchestrator
// merges, and nobody else rewrites history or throws away working-tree changes.
const GIT_CALL = /\bgit(?:\s+(?:-[Cc]\s+\S+|-{1,2}[\w-]+(?:=\S+)?))*\s+([a-z][\w-]*)([^;&|\n]*)/g;
const GIT_DENIED = new Set(['push', 'commit', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'stash', 'clean',
  'restore', 'checkout', 'switch', 'am', 'tag', 'update-ref', 'filter-branch', 'filter-repo', 'gc', 'prune',
  'reflog', 'worktree', 'replace', 'notes', 'pull']);
function destructiveGit(cmd) {
  for (const [, sub, rest] of unquote(cmd).matchAll(GIT_CALL)) {
    if (GIT_DENIED.has(sub)) return `git ${sub}`;
    if (sub === 'branch' && /\s(-[dDmMcCf]\b|--(delete|force|move|copy)\b)/.test(rest)) return 'git branch' + rest.replace(/\s+$/, '');
  }
  return null;
}

const deny = (msg) => { process.stderr.write(`tnt guard: ${msg}\n`); process.exit(2); };
const ask = (msg) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `tnt guard: ${msg}` } }));
  process.exit(0);
};
const posix = (p) => p.replace(/\\/g, '/');

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const root = findRoot(input.cwd || projectDir) || findRoot(projectDir);
if (!root) process.exit(0);

const tool = input.tool_name;
const agent = String(input.agent_type || '').replace(/^.*:/, '');
// Claude Code sets agent_id (and agent_type) on hooks that fire inside a subagent.
const subagent = Boolean(input.agent_id || input.agent_type);
const locked = lockedFiles(root);

if (FILE_TOOLS.has(tool)) {
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) process.exit(0);
  const rel = posix(path.relative(root, path.resolve(input.cwd || root, target)));
  if (rel.startsWith('..')) process.exit(0);
  if (PROTECTED.some((re) => re.test(rel))) deny(`${rel} is written only by the tnt CLI. Record evidence with \`tnt run\`, \`tnt review submit\` or \`tnt audit submit\` instead.`);
  if (agent in VERIFIER_WRITABLE && !VERIFIER_WRITABLE[agent].some((re) => re.test(rel))) deny(`${agent} may only write its own files and must not modify ${rel}. Report the problem as a finding; the orchestrator routes fixes to a producer step.`);
  if (locked.has(rel)) deny(`${rel} is a locked acceptance test (red gate passed). Implementation must satisfy the tests as written. If the test itself is wrong, stop and report it; the orchestrator decides whether to \`tnt unlock\`.`);
  process.exit(0);
}

if (SHELL_TOOLS.has(tool)) {
  const cmd = posix(String(input.tool_input?.command || ''));
  if (subagent) {
    for (const [, sub] of cmd.matchAll(TNT_CALL)) {
      if (ORCHESTRATOR_ONLY.has(sub)) deny(`\`tnt ${sub}\` belongs to the orchestrator or a person, never to a step. Use \`tnt check\` to see what a gate would say, and report anything that needs a decision.`);
    }
    if (HARNESS_IMPORT.test(cmd) && /\b(import|require)\b/.test(cmd)) deny('steps use the tnt CLI, not the harness modules directly.');
    const git = destructiveGit(cmd);
    if (git) deny(`\`${git}\` is not a step's job: the harness commits, the orchestrator merges, and changes are never discarded or history rewritten. Report what you need instead.`);
  }
  if (writes(cmd)) {
    if (/\.tnt\/(ledger\.jsonl|active\.json|view\.html|evidence\/|_project\/(ledger\.jsonl|evidence\/)|(features|reviews)\/[^\s'"]+\/(ledger\.jsonl|state\.json|report\.md|evidence\/))/.test(cmd)) {
      deny('shell commands must not write harness-owned files under .tnt/. Use the tnt CLI.');
    }
    for (const file of locked) {
      if (cmd.includes(file)) deny(`command appears to modify locked acceptance test ${file}. Locked tests are read-only until \`tnt unlock\`.`);
    }
  }
  const decision = humanDecision(cmd);
  if (decision) ask(`\`tnt ${decision}\` records a human decision in the ledger. Approve only if you made this decision yourself and the --by name is yours.`);
  process.exit(0);
}
process.exit(0);

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, TNT, 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function lockedFiles(root) {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(root, TNT, 'active.json'), 'utf8'));
    const featuresDir = path.join(root, TNT, 'features');
    const dir = fs.readdirSync(featuresDir).find((d) => d === active.feature || d.startsWith(active.feature + '-'));
    const state = JSON.parse(fs.readFileSync(path.join(featuresDir, dir, 'state.json'), 'utf8'));
    if (!LOCK_PHASES.has(state.phase) || !state.locked) return new Set();
    return new Set(Object.keys(state.locked.files));
  } catch {
    return new Set();
  }
}
