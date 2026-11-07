#!/usr/bin/env node
// PreToolUse guard. Keeps evidence tamper-proof and steps independent:
//  1. Nobody writes harness-owned files (ledgers, state, evidence, reports)
//     except through the tnt CLI.
//  2. Once the red gate passes, locked test files are read-only until the
//     orchestrator runs `tnt unlock`.
//  3. Verifier subagents may only write their own draft files.
// Exit 2 blocks the tool call; stderr is shown to the model.
import fs from 'node:fs';
import path from 'node:path';

const TNT = '.tnt';
const PROTECTED = [
  /^\.tnt\/ledger\.jsonl$/, // the single ledger of tnt 0.1
  /^\.tnt\/active\.json$/,
  /^\.tnt\/evidence\//,
  /^\.tnt\/_project\/(ledger\.jsonl$|evidence\/)/,
  /^\.tnt\/features\/[^/]+\/(ledger\.jsonl|state\.json|report\.md)$/,
  /^\.tnt\/features\/[^/]+\/evidence\//,
];
const VERIFIER_WRITABLE = {
  'code-reviewer': [/^\.tnt\/features\/[^/]+\/review\.draft\.json$/],
  'evidence-auditor': [/^\.tnt\/features\/[^/]+\/audit\.draft\.json$/],
  'functional-tester': [/^\.tnt\/features\/[^/]+\/functional\//],
  'style-verifier': [],
};
const LOCK_PHASES = new Set(['red', 'green', 'style', 'review', 'functional', 'audit', 'done']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// A command "writes" if it has a shell redirect outside quotes (so `=>`, `>=`
// and "a > b" inside node -e / echo strings don't count), or uses a
// write-capable command or API anywhere.
const WRITE_WORDS = /\btee\b|\bcp\b|\bmv\b|\brm\b|\bsed\s+-i|\bperl\s+-[a-z]*i|\btruncate\b|\bdd\b|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Clear-Content|New-Item|writeFile|appendFile|createWriteStream|copyFile|rename(Sync)?\(|unlink|open\([^)]*['"][wa]/i;
function writes(cmd) {
  const unquoted = cmd
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/\d?>&\d|&>\s*\/dev\/null/g, '')
    .replace(/\d?>\s*(\/dev\/null|\$null|nul)\b/gi, '');
  return />/.test(unquoted) || WRITE_WORDS.test(cmd);
}

const deny = (msg) => { process.stderr.write(`tnt guard: ${msg}\n`); process.exit(2); };
const posix = (p) => p.replace(/\\/g, '/');

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const root = findRoot(input.cwd || projectDir) || findRoot(projectDir);
if (!root) process.exit(0);

const tool = input.tool_name;
const agent = String(input.agent_type || '').replace(/^.*:/, '');
const locked = lockedFiles(root);

if (FILE_TOOLS.has(tool)) {
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) process.exit(0);
  const rel = posix(path.relative(root, path.resolve(input.cwd || root, target)));
  if (rel.startsWith('..')) process.exit(0);
  if (PROTECTED.some((re) => re.test(rel))) deny(`${rel} is written only by the tnt CLI. Record evidence with \`tnt run\`, \`tnt review submit\` or \`tnt audit submit\` instead.`);
  if (agent in VERIFIER_WRITABLE && !VERIFIER_WRITABLE[agent].some((re) => re.test(rel))) deny(`${agent} is a verifier and must not modify ${rel}. Report the problem as a finding; the orchestrator routes fixes to a producer step.`);
  if (locked.has(rel)) deny(`${rel} is a locked acceptance test (red gate passed). Implementation must satisfy the tests as written. If the test itself is wrong, stop and report it; the orchestrator decides whether to \`tnt unlock\`.`);
  process.exit(0);
}

if (SHELL_TOOLS.has(tool)) {
  const cmd = posix(String(input.tool_input?.command || ''));
  if (!writes(cmd)) process.exit(0);
  if (/\.tnt\/(ledger\.jsonl|active\.json|evidence\/|_project\/(ledger\.jsonl|evidence\/)|features\/[^\s'"]+\/(ledger\.jsonl|state\.json|report\.md|evidence\/))/.test(cmd)) {
    deny('shell commands must not write harness-owned files under .tnt/. Use the tnt CLI.');
  }
  for (const file of locked) {
    if (cmd.includes(file)) deny(`command appears to modify locked acceptance test ${file}. Locked tests are read-only until \`tnt unlock\`.`);
  }
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
