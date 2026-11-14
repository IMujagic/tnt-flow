// Harness operations: every state transition goes through here, is
// validated against recorded evidence, and is appended to the ledger.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeView } from './view.mjs';
import {
  TNT_DIR, GATES, PROJECT_FEATURE, TntError, sha256, toPosix, readJson, writeJson,
  git, gitToplevel, head, treeHash, isClean, changedFiles, readTreeFile, commitAll,
  DEFAULT_CONFIG, configPath, loadConfig, readLedger, nextSeq, appendLedger, verifyLedger, verifyAllLedgers,
  projectDir, scopeDir, FEATURE_ID, ensureLocalIgnores,
  featuresDir, listFeatures, resolveFeature, loadState, saveState, specPath, evidenceDir,
  activePath, readActive, SPEC_TEMPLATE, slugify, parseAcceptanceCriteria, acRegex, fileSha, relPath,
} from './core.mjs';

const SEVERITIES = ['blocking', 'major', 'minor', 'nit'];

// ---------------------------------------------------------------- init / project

export function init(cwd, { type = 'existing', force = false } = {}) {
  const root = gitToplevel(cwd);
  if (!root) throw new TntError('not a git repository. Run `git init` first; evidence is bound to git tree hashes.');
  if (fs.existsSync(configPath(root)) && !force) throw new TntError(`${TNT_DIR}/config.json already exists (use --force to overwrite)`);
  const config = structuredClone(DEFAULT_CONFIG);
  config.project = { name: path.basename(root), type };
  writeJson(configPath(root), config);
  fs.mkdirSync(featuresDir(root), { recursive: true });
  fs.mkdirSync(evidenceDir(root, null), { recursive: true });
  ensureLocalIgnores(root);
  appendLedger(projectDir(root), { type: 'init', feature: PROJECT_FEATURE, projectType: type });
  return { root, config };
}

export function configCheck(root) {
  const config = loadConfig(root);
  const problems = [];
  if (!config.commands.test) problems.push('commands.test is not set');
  if (!config.style.length) problems.push('style[] is empty: list the command names (e.g. "lint", "format_check", "typecheck") the style gate must run');
  for (const name of config.style) if (!config.commands[name]) problems.push(`style lists "${name}" but commands.${name} is not set`);
  return { ok: problems.length === 0, problems, config };
}

export function resolveShell(config) {
  if (config.shell) return config.shell;
  if (process.platform !== 'win32') return true;
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH && fs.existsSync(process.env.CLAUDE_CODE_GIT_BASH_PATH)) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (r.status === 0) {
    const bash = path.resolve(r.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe');
    if (fs.existsSync(bash)) return bash;
  }
  return true;
}

// ---------------------------------------------------------------- recorded execution

export function execRecorded(root, opts) {
  const { feature, featureDir, step, name, ac, cmd, expect, artifacts = [] } = opts;
  const config = loadConfig(root);
  if (!cmd || !cmd.trim()) throw new TntError('empty command');
  let expectRe;
  if (expect) {
    try { expectRe = new RegExp(expect, 'm'); } catch (e) { throw new TntError(`--expect is not a valid regex: ${e.message}`); }
  }
  for (const a of artifacts) if (!fs.existsSync(path.resolve(root, a))) throw new TntError(`artifact not found: ${a}`);

  const scope = scopeDir(root, featureDir);
  const seq = nextSeq(scope);
  const r = runCommand(root, config, { cmd, expectRe, env: { TNT_FEATURE: feature, TNT_STEP: step } });
  const { tree, treeAfter, head: h, exit, timedOut, durationMs, expectMatched } = r;

  const evDir = evidenceDir(root, featureDir);
  fs.mkdirSync(evDir, { recursive: true });
  const stem = [String(seq).padStart(4, '0'), step, name, ac].filter(Boolean).join('-');
  const logAbs = path.join(evDir, `${stem}.log`);
  fs.writeFileSync(logAbs, logText(cmd, expect, r));

  const savedArtifacts = artifacts.map((a, i) => {
    const src = path.resolve(root, a);
    const dest = path.join(evDir, `${stem}-artifact${i + 1}-${path.basename(src)}`);
    fs.copyFileSync(src, dest);
    return { source: relPath(root, src), path: relPath(root, dest), sha256: sha256(fs.readFileSync(dest)) };
  });

  return appendLedger(scope, {
    type: 'run', feature, step, name, ac, cmd, exit, timedOut, durationMs, tree, treeAfter,
    mutated: tree !== treeAfter, head: h, log: relPath(root, logAbs), logSha256: sha256(fs.readFileSync(logAbs)),
    expect, expectMatched, artifacts: savedArtifacts.length ? savedArtifacts : undefined,
  });
}

// Runs one command in the project with the configured shell and reports what
// happened, including whether it changed the working tree. Records nothing.
function runCommand(root, config, { cmd, expectRe, env = {} }) {
  const tree = treeHash(root);
  const h = head(root);
  const t0 = Date.now();
  const r = spawnSync(cmd, {
    cwd: root, shell: resolveShell(config), maxBuffer: 512 * 1024 * 1024, timeout: config.timeouts.commandMs,
    env: { ...process.env, ...env },
  });
  const durationMs = Date.now() - t0;
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const exit = typeof r.status === 'number' ? r.status : 1;
  const stdout = r.stdout ? r.stdout.toString('utf8') : '';
  const stderr = (r.stderr ? r.stderr.toString('utf8') : '') + (r.error && !timedOut ? `\n[tnt] spawn error: ${r.error.message}` : '');
  const treeAfter = treeHash(root);
  const expectMatched = expectRe ? expectRe.test(stdout + '\n' + stderr) : undefined;
  return { tree, treeAfter, head: h, exit, timedOut, durationMs, stdout, stderr, expectMatched };
}

function logText(cmd, expect, r) {
  return [
    `$ ${cmd}`, `# exit: ${r.exit}${r.timedOut ? ' (timed out)' : ''}`, `# duration_ms: ${r.durationMs}`,
    `# tree: ${r.tree}${r.tree !== r.treeAfter ? `  (MUTATED -> ${r.treeAfter})` : ''}`, `# head: ${r.head ?? '(none)'}`,
    expect ? `# expect: /${expect}/m -> ${r.expectMatched ? 'matched' : 'NOT matched'}` : null,
    '---- stdout ----', r.stdout, '---- stderr ----', r.stderr,
  ].filter((l) => l !== null).join('\n');
}

export function baseline(root) {
  const { ok, problems, config } = configCheck(root);
  if (!config.commands.test) throw new TntError(problems.join('; '));
  const names = ['test', ...config.style.filter((n) => config.commands[n])];
  const runs = names.map((n) => execRecorded(root, { feature: PROJECT_FEATURE, featureDir: null, step: 'baseline', name: n, cmd: config.commands[n] }));
  return { runs, configProblems: ok ? [] : problems };
}

// ---------------------------------------------------------------- features

// Crockford base32 (no I, L, O, U): 6 characters give about a billion ids, so
// features planned on different branches don't collide when they merge.
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const randomId = () => 'F-' + [...crypto.randomBytes(6)].map((b) => ID_ALPHABET[b % 32]).join('');

export function newFeature(root, title, { id: wanted } = {}) {
  if (!title || !title.trim()) throw new TntError('feature title required');
  const taken = new Set(listFeatures(root).map((f) => f.id));
  let id;
  if (wanted) {
    id = wanted.toUpperCase();
    if (!FEATURE_ID.test(id)) throw new TntError(`feature id "${wanted}" must look like F-<letters and digits>, with no further "-" (e.g. F-042, F-PAY12)`);
    if (taken.has(id)) throw new TntError(`feature ${id} already exists`);
  } else {
    do id = randomId(); while (taken.has(id));
  }
  const dir = path.join(featuresDir(root), `${id}-${slugify(title)}`);
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.writeFileSync(specPath(dir), SPEC_TEMPLATE(id, title.trim()));
  saveState(dir, { id, title: title.trim(), created: new Date().toISOString(), phase: 'draft', gates: {}, attempts: {}, locked: null, approval: null, base: null, syncedBase: null, branch: null, unlocks: [], waivers: [] });
  appendLedger(dir, { type: 'feature-created', feature: id, title: title.trim() });
  return { id, dir };
}

function specInfo(featureDir) {
  const text = fs.readFileSync(specPath(featureDir), 'utf8');
  return { text, sha: sha256(text), acs: parseAcceptanceCriteria(text) };
}

function specProblems(spec) {
  const p = [];
  if (!spec.acs.length) p.push('spec has no acceptance criteria (lines like "- AC-1: Given ..., when ..., then ...")');
  for (const ac of spec.acs) if (/\.\.\.|<[^>]+>/.test(ac.text)) p.push(`${ac.id} still contains template placeholders`);
  return p;
}

export function approve(root, ref, { by }) {
  if (!by) throw new TntError('--by "<human name>" is required: approval records who signed off on the spec');
  const f = resolveFeature(root, ref);
  const spec = specInfo(f.dir);
  const problems = specProblems(spec);
  if (problems.length) throw new TntError(problems.join('; '));
  const e = appendLedger(f.dir, { type: 'approve', feature: f.id, by, specSha: spec.sha, acs: spec.acs.map((a) => a.id) });
  const state = loadState(f.dir);
  state.approval = { by, seq: e.seq, specSha: spec.sha };
  saveState(f.dir, state);
  return gate(root, f.id, 'spec');
}

export function start(root, ref) {
  const f = resolveFeature(root, ref);
  const config = loadConfig(root);
  const state = loadState(f.dir);
  if (!state.gates.spec) throw new TntError(`${f.id}: spec gate not passed; get the spec approved first`);
  if (state.base !== null) return { feature: f.id, alreadyStarted: true, branch: state.branch, base: state.base };
  const active = readActive(root);
  if (active && active.feature !== f.id) {
    const other = resolveFeature(root, active.feature);
    if (loadState(other.dir).phase !== 'done') throw new TntError(`${active.feature} is still in progress; finish it first (one active feature at a time)`);
  }
  if (!isClean(root)) throw new TntError('working tree has uncommitted changes outside .tnt/; commit or stash them so the feature diff is attributable');
  let branch = null;
  const h = head(root);
  const from = h ? git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() : '';
  if (config.git.branchPerFeature && h) {
    branch = `${config.git.branchPrefix}${f.dirName}`;
    git(root, ['checkout', '-q', '-b', branch]);
  }
  state.base = h ?? '';
  state.baseBranch = from && from !== 'HEAD' ? from : null;
  state.branch = branch;
  saveState(f.dir, state);
  ensureLocalIgnores(root);
  writeJson(activePath(root), { feature: f.id });
  appendLedger(f.dir, { type: 'start', feature: f.id, base: state.base, branch });
  return { feature: f.id, branch, base: state.base };
}

export function lockTests(root, ref, files, { replace = false } = {}) {
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  if (!state.gates.spec) throw new TntError(`${f.id}: spec gate not passed`);
  if (state.gates.red) throw new TntError(`${f.id}: tests are locked by the red gate; ask the orchestrator to \`tnt unlock\` with a reason`);
  if (!files.length) throw new TntError('list the test files to lock');
  const rels = files.map((p) => relPath(root, p));
  for (const r of rels) {
    if (r.startsWith('..')) throw new TntError(`${r} is outside the project`);
    if (r.startsWith(TNT_DIR + '/')) throw new TntError(`${r}: tests must live in the project, not ${TNT_DIR}/`);
    if (!fs.existsSync(path.join(root, r))) throw new TntError(`${r} does not exist`);
  }
  const set = new Set([...(replace || !state.locked ? [] : Object.keys(state.locked.files)), ...rels]);
  const hashes = Object.fromEntries([...set].sort().map((r) => [r, fileSha(root, r)]));
  const e = appendLedger(f.dir, { type: 'lock-tests', feature: f.id, files: hashes });
  state.locked = { files: hashes, seq: e.seq };
  saveState(f.dir, state);
  return state.locked;
}

export function unlock(root, ref, { reason }) {
  if (!reason) throw new TntError('--reason is required');
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  if (!state.gates.red) throw new TntError(`${f.id}: tests are not locked`);
  const e = appendLedger(f.dir, { type: 'unlock', feature: f.id, reason });
  clearFrom(state, 'red');
  state.phase = 'spec';
  state.unlocks.push({ seq: e.seq, reason });
  saveState(f.dir, state);
  return state;
}

// ---------------------------------------------------------------- gates

function clearFrom(state, g) {
  for (const x of GATES.slice(GATES.indexOf(g))) delete state.gates[x];
}

const latest = (entries, pred) => { for (let i = entries.length - 1; i >= 0; i--) if (pred(entries[i])) return entries[i]; return null; };

// Functional evidence for one AC on one tree: the latest run of each distinct
// command. Extra probes add to the evidence; re-recording the same command
// (e.g. with a corrected --expect) supersedes its earlier run; every command's
// latest run must pass, so a failing probe blocks until it passes.
function functionalRuns(ledger, featureId, acId, tree) {
  const byCmd = new Map();
  for (const e of ledger) {
    if (e.type === 'run' && e.feature === featureId && e.step === 'functional' && e.ac === acId && e.tree === tree) byCmd.set(e.cmd, e);
  }
  return [...byCmd.values()].sort((a, b) => a.seq - b.seq);
}

function runIssues(run, tree, label) {
  if (!run) return [`no ${label} run recorded`];
  const p = [];
  if (run.timedOut) p.push(`${label} run #${run.seq} timed out`);
  if (run.mutated) p.push(`${label} run #${run.seq} modified the working tree while running; evidence must not change the code it proves`);
  if (run.tree !== tree) p.push(`${label} run #${run.seq} was recorded against tree ${run.tree.slice(0, 10)}, but the current tree is ${tree.slice(0, 10)}; re-run it`);
  return p;
}

function lockedIssues(root, state) {
  if (!state.locked || !Object.keys(state.locked.files).length) return ['no test files locked (`tnt lock-tests`)'];
  const p = [];
  for (const [file, want] of Object.entries(state.locked.files)) {
    const got = fileSha(root, file);
    if (got === null) p.push(`locked test ${file} was deleted`);
    else if (got !== want) p.push(`locked test ${file} was modified after locking`);
  }
  return p;
}

const EVALUATORS = {
  spec(ctx) {
    const { state, spec } = ctx;
    const p = specProblems(spec);
    if (!state.approval) p.push('spec not approved (`tnt approve <F> --by <name>`)');
    else if (state.approval.specSha !== spec.sha) p.push('spec.md changed after approval; re-approve');
    return p;
  },
  red(ctx) {
    const { root, state, spec, config, ledger, tree, f } = ctx;
    const p = lockedIssues(root, state);
    if (p.length) return p;
    const contents = Object.keys(state.locked.files).map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    for (const ac of spec.acs) if (!acRegex(ac.id).test(contents)) p.push(`${ac.id} is not referenced by any locked test (name tests after their AC: "${ac.id}: ...", or test_ac_${ac.id.slice(3)}_..., TestAC${ac.id.slice(3)}..., ac${ac.id.slice(3)}_... where names can't contain "-")`);
    const run = latest(ledger, (e) => e.type === 'run' && e.feature === f.id && e.step === 'red' && e.seq > state.locked.seq);
    p.push(...runIssues(run, tree, 'red (after the latest lock-tests)'));
    if (run) {
      if (run.exit === 0) p.push(`red run #${run.seq} passed (exit 0); new tests must fail before implementation exists`);
      if (config.red.requireAcInOutput) {
        const log = fs.readFileSync(path.join(root, run.log), 'utf8');
        if (!spec.acs.some((ac) => acRegex(ac.id).test(log))) p.push(`red run #${run.seq} output mentions no AC id; the failure must come from the new acceptance tests, not a broken build`);
      }
    }
    return p;
  },
  green(ctx) {
    const { root, state, ledger, tree, f } = ctx;
    const p = lockedIssues(root, state);
    const run = latest(ledger, (e) => e.type === 'run' && e.feature === f.id && e.step === 'green' && e.seq > state.gates.red.seq);
    p.push(...runIssues(run, tree, 'green (after the red gate)'));
    if (run && run.exit !== 0) p.push(`green run #${run.seq} failed (exit ${run.exit}); see ${run.log}`);
    if (run && run.tree === state.gates.red.tree) p.push('tests failed and then passed on identical code: the suite is nondeterministic');
    return p;
  },
  style(ctx) {
    const { config, ledger, tree, f } = ctx;
    if (!config.style.length) return ['config.style is empty; the style gate needs at least one command to prove'];
    const p = [];
    for (const name of config.style) {
      if (!config.commands[name]) { p.push(`commands.${name} is not configured`); continue; }
      const run = latest(ledger, (e) => e.type === 'run' && e.feature === f.id && e.step === 'style' && e.name === name && e.tree === tree);
      p.push(...runIssues(run, tree, `style:${name}`));
      if (run && run.exit !== 0) p.push(`style:${name} run #${run.seq} failed (exit ${run.exit}); see ${run.log}`);
    }
    return p;
  },
  review(ctx) {
    const { ledger, tree, f } = ctx;
    const r = latest(ledger, (e) => e.type === 'review' && e.feature === f.id);
    if (!r) return ['no review submitted (`tnt review submit`)'];
    const p = [];
    if (r.tree !== tree) p.push(`review #${r.seq} covers tree ${r.tree.slice(0, 10)}, not the current tree; request a fresh review`);
    if (r.verdict !== 'approve') p.push(`review #${r.seq} requested changes (${r.counts.blocking} blocking, ${r.counts.major} major); see ${r.file}`);
    return p;
  },
  functional(ctx) {
    const { spec, ledger, tree, f } = ctx;
    const p = [];
    for (const ac of spec.acs) {
      const runs = functionalRuns(ledger, f.id, ac.id, tree);
      if (!runs.length) { p.push(`${ac.id}: no functional evidence on the current tree`); continue; }
      for (const run of runs) {
        const issues = runIssues(run, tree, `functional ${ac.id}`);
        if (run.exit !== 0) issues.push(`${ac.id}: functional run #${run.seq} exited ${run.exit}`);
        if (run.expectMatched !== true) issues.push(`${ac.id}: functional run #${run.seq} has no matching --expect; evidence must assert an observable outcome`);
        p.push(...issues);
      }
    }
    return p;
  },
  audit(ctx) {
    const { ledger, tree, f } = ctx;
    const p = [];
    const v = latest(ledger, (e) => e.type === 'verify' && e.feature === f.id);
    if (!v) p.push('no `tnt verify` recorded');
    else {
      if (v.tree !== tree) p.push(`verify #${v.seq} ran on a different tree`);
      if (!v.ok) p.push(`verify #${v.seq} failed: ${v.failures.join('; ')}`);
    }
    const a = latest(ledger, (e) => e.type === 'audit-report' && e.feature === f.id);
    if (!a) p.push('no audit report submitted (`tnt audit submit`)');
    else {
      if (a.tree !== tree) p.push(`audit report #${a.seq} covers a different tree`);
      if (a.verdict !== 'pass') p.push(`audit report #${a.seq} verdict is ${a.verdict}; see ${a.file}`);
    }
    return p;
  },
};

function gateContext(root, f) {
  return {
    root, f, state: loadState(f.dir), config: loadConfig(root), spec: specInfo(f.dir), ledger: readLedger(f.dir), tree: treeHash(root),
  };
}

function preconditions(ctx, g) {
  const { state, spec, tree } = ctx;
  const p = [];
  const idx = GATES.indexOf(g);
  for (const prev of GATES.slice(0, idx)) if (!state.gates[prev]) { p.push(`gate "${prev}" has not passed yet`); return p; }
  if (g !== 'spec') {
    if (!state.approval || state.approval.specSha !== spec.sha) p.push('spec.md changed after approval; re-approve before continuing');
    if (state.base === null) p.push('feature not started (`tnt start`)');
  }
  if (idx > GATES.indexOf('green') && state.gates.green.tree !== tree) {
    p.push('code changed since the green gate; re-run `tnt run <F> green` and pass the green gate again');
  }
  return p;
}

const COMMIT_ON = { red: (f) => `test(${f.id}): failing acceptance tests [tnt:red]`, green: (f, s) => `feat(${f.id}): ${s.title} [tnt:green]`, audit: (f) => `chore(${f.id}): evidence and report [tnt:done]` };

function evaluate(root, ref, g) {
  if (!GATES.includes(g)) throw new TntError(`unknown gate "${g}"; one of ${GATES.join(', ')}`);
  const f = resolveFeature(root, ref);
  const ctx = gateContext(root, f);
  let reasons = preconditions(ctx, g);
  if (!reasons.length) reasons = EVALUATORS[g](ctx);
  return { f, ctx, reasons };
}

// Side-effect-free self-check for producer/verifier subagents: no ledger
// entry, no state change, no commit, no attempt counted. Only the
// orchestrator calls `gate`.
export function check(root, ref, g) {
  const { f, reasons } = evaluate(root, ref, g);
  return { feature: f.id, gate: g, pass: reasons.length === 0, reasons, dryRun: true };
}

export function gate(root, ref, g) {
  const { f, ctx, reasons } = evaluate(root, ref, g);
  const pass = reasons.length === 0;
  const e = appendLedger(f.dir, { type: 'gate', feature: f.id, gate: g, pass, tree: ctx.tree, reasons: pass ? undefined : reasons });
  const state = loadState(f.dir);
  let commit = null;
  if (pass) {
    clearFrom(state, g);
    state.gates[g] = { seq: e.seq, tree: ctx.tree, ts: e.ts };
    state.phase = g === 'audit' ? 'done' : g;
    state.attempts[g] = 0;
    saveState(f.dir, state);
    if (g === 'audit') {
      writeReport(root, f.id);
      const active = readActive(root);
      if (active?.feature === f.id) fs.rmSync(activePath(root), { force: true });
    }
    if (ctx.config.git.autoCommit && COMMIT_ON[g]) commit = commitAll(root, COMMIT_ON[g](f, state));
  } else {
    state.attempts[g] = (state.attempts[g] || 0) + 1;
    saveState(f.dir, state);
  }
  const attempts = state.attempts[g];
  return { feature: f.id, gate: g, pass, reasons, seq: e.seq, phase: state.phase, attempts, maxIterations: ctx.config.limits.maxIterations, commit };
}

export function waive(root, ref, g, { reason, by }) {
  if (!reason || !by) throw new TntError('--reason and --by are required: a waiver is a recorded human decision');
  const f = resolveFeature(root, ref);
  const ctx = gateContext(root, f);
  const idx = GATES.indexOf(g);
  if (idx < 1) throw new TntError(`gate "${g}" cannot be waived`);
  for (const prev of GATES.slice(0, idx)) if (!ctx.state.gates[prev]) throw new TntError(`gate "${prev}" has not passed yet`);
  const e = appendLedger(f.dir, { type: 'waive', feature: f.id, gate: g, reason, by, tree: ctx.tree });
  const state = loadState(f.dir);
  clearFrom(state, g);
  state.gates[g] = { seq: e.seq, tree: ctx.tree, ts: e.ts, waived: true };
  state.phase = g === 'audit' ? 'done' : g;
  state.waivers.push({ gate: g, seq: e.seq, reason, by });
  saveState(f.dir, state);
  return state;
}

// ---------------------------------------------------------------- review / audit submissions

function normalize(s) { return s.replace(/\s+/g, ' ').trim(); }

export function submitReview(root, ref, file) {
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  if (!state.gates.style) throw new TntError(`${f.id}: style gate has not passed; review comes after style`);
  let review;
  try { review = readJson(path.resolve(root, file)); } catch (e) { throw new TntError(`cannot read review JSON: ${e.message}`); }
  const tree = treeHash(root);
  const errors = [];
  if (!['approve', 'changes_requested'].includes(review.verdict)) errors.push('verdict must be "approve" or "changes_requested"');
  if (!Array.isArray(review.files_reviewed)) errors.push('files_reviewed must be an array of paths');
  if (!Array.isArray(review.findings)) errors.push('findings must be an array (empty if none)');
  if (errors.length) throw new TntError(errors.join('; '));

  // After `tnt sync` the diff starts at the integrated base, so upstream work
  // merged into the branch is not part of this feature's review.
  const changed = changedFiles(root, state.syncedBase || state.base || null, tree);
  const reviewed = new Set(review.files_reviewed.map((p) => relPath(root, p)));
  const missed = changed.filter((c) => !reviewed.has(c));
  if (missed.length) errors.push(`not reviewed: ${missed.join(', ')} (every changed file must be read)`);

  review.findings.forEach((fd, i) => {
    const tag = `finding ${fd.id ?? i + 1}`;
    if (!SEVERITIES.includes(fd.severity)) errors.push(`${tag}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (!fd.issue) errors.push(`${tag}: missing "issue"`);
    if (!fd.file || !Number.isInteger(fd.line) || !fd.quote) { errors.push(`${tag}: needs file, integer line and a verbatim quote`); return; }
    const text = readTreeFile(root, tree, relPath(root, fd.file));
    if (text === null) { errors.push(`${tag}: ${fd.file} is not in the reviewed tree`); return; }
    const lines = text.split(/\r?\n/);
    const window = normalize(lines.slice(Math.max(0, fd.line - 3), fd.line + 2).join('\n'));
    if (!window.includes(normalize(fd.quote))) errors.push(`${tag}: quote not found near ${fd.file}:${fd.line}; cite code that exists`);
  });
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, review.findings.filter((x) => x.severity === s).length]));
  if (review.verdict === 'approve' && (counts.blocking || counts.major)) errors.push('cannot approve with blocking or major findings');
  if (errors.length) throw new TntError(`review rejected:\n  - ${errors.join('\n  - ')}`);

  const seq = nextSeq(f.dir);
  const dest = path.join(f.dir, 'evidence', `${String(seq).padStart(4, '0')}-review.json`);
  writeJson(dest, review);
  return appendLedger(f.dir, { type: 'review', feature: f.id, verdict: review.verdict, counts, tree, file: relPath(root, dest), fileSha256: sha256(fs.readFileSync(dest)) });
}

export function submitAudit(root, ref, file) {
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  if (!state.gates.functional) throw new TntError(`${f.id}: functional gate has not passed`);
  let report;
  try { report = readJson(path.resolve(root, file)); } catch (e) { throw new TntError(`cannot read audit JSON: ${e.message}`); }
  const errors = [];
  if (!['pass', 'fail'].includes(report.verdict)) errors.push('verdict must be "pass" or "fail"');
  if (!Array.isArray(report.checks) || !report.checks.length) errors.push('checks must be a non-empty array');
  else report.checks.forEach((c, i) => {
    if (!c.name || !['pass', 'fail'].includes(c.result) || !c.evidence) errors.push(`check ${i + 1}: needs name, result (pass|fail) and evidence (ledger #seq or file:line)`);
  });
  if (report.verdict === 'pass' && report.checks?.some((c) => c.result === 'fail')) errors.push('verdict is pass but a check failed');
  if (errors.length) throw new TntError(`audit report rejected:\n  - ${errors.join('\n  - ')}`);
  const seq = nextSeq(f.dir);
  const dest = path.join(f.dir, 'evidence', `${String(seq).padStart(4, '0')}-audit.json`);
  writeJson(dest, report);
  return appendLedger(f.dir, { type: 'audit-report', feature: f.id, verdict: report.verdict, tree: treeHash(root), file: relPath(root, dest), fileSha256: sha256(fs.readFileSync(dest)) });
}

// ---------------------------------------------------------------- independent re-verification

export function verify(root, ref) {
  const f = resolveFeature(root, ref);
  const config = loadConfig(root);
  const state = loadState(f.dir);
  const failures = [];
  const integrity = verifyLedger(root, f.dir);
  failures.push(...integrity.errors.map((e) => `ledger: ${e}`));
  const tree = treeHash(root);
  if (!state.gates.green) failures.push('green gate has not passed');
  else if (state.gates.green.tree !== tree) failures.push('current tree differs from the green-gated tree');
  if (state.locked) failures.push(...lockedIssues(root, state));

  const reruns = [];
  const rerun = (opts, check) => {
    const r = execRecorded(root, { feature: f.id, featureDir: f.dir, step: 'audit', ...opts });
    reruns.push(r.seq);
    const p = check(r);
    if (r.mutated) p.push('modified the working tree');
    if (p.length) failures.push(`re-run ${opts.name ?? opts.ac} (#${r.seq}): ${p.join(', ')}`);
  };
  if (config.commands.test) rerun({ name: 'test', cmd: config.commands.test }, (r) => (r.exit === 0 ? [] : [`exit ${r.exit}`]));
  else failures.push('commands.test not configured');
  for (const name of config.style) if (config.commands[name]) rerun({ name, cmd: config.commands[name] }, (r) => (r.exit === 0 ? [] : [`exit ${r.exit}`]));

  const ledger = readLedger(f.dir);
  let acs = [];
  try { acs = specInfo(f.dir).acs; } catch (e) { failures.push(e.message); }
  const gatedTree = state.gates.green?.tree ?? tree;
  for (const ac of acs) {
    const runs = functionalRuns(ledger, f.id, ac.id, gatedTree).filter((e) => e.exit === 0 && e.expectMatched === true);
    if (!runs.length) { failures.push(`${ac.id}: no passing functional evidence to reproduce`); continue; }
    for (const run of runs) {
      rerun({ ac: ac.id, name: 'functional', cmd: run.cmd, expect: run.expect }, (r) => [
        ...(r.exit === 0 ? [] : [`exit ${r.exit}`]), ...(r.expectMatched ? [] : ['expected output no longer observed']),
      ]);
    }
  }
  const ok = failures.length === 0;
  const e = appendLedger(f.dir, { type: 'verify', feature: f.id, ok, tree: treeHash(root), reruns, failures });
  return { ok, failures, seq: e.seq, reruns };
}

// Re-proves features on whatever tree is checked out, typically a pull
// request's merge commit in CI. The branch's evidence was bound to the
// branch's tree; the merged tree is new code that nobody has run. This runs
// the full suite and style commands once, then every passing functional check
// of each done feature, and judges the results from scratch. It writes nothing
// to .tnt/ (CI must not need to commit), only optional logs under --out.
export function verifyIntegrated(root, refs = [], { out } = {}) {
  const config = loadConfig(root);
  const failures = [];
  const integrity = verifyAllLedgers(root);
  failures.push(...integrity.errors.map((e) => `ledger ${e}`));

  const all = listFeatures(root);
  const selected = refs.length ? refs.map((r) => resolveFeature(root, r)) : all.filter((f) => f.state.base !== null);
  for (const f of selected) if (f.state.phase !== 'done') failures.push(`${f.id} is not done (phase ${f.state.phase}); finish or remove it before merging`);

  const tree = treeHash(root);
  const runs = [];
  if (out) fs.mkdirSync(out, { recursive: true });
  const exec = (label, cmd, expect, extra = {}) => {
    const r = runCommand(root, config, { cmd, expectRe: expect ? new RegExp(expect, 'm') : undefined, env: { TNT_STEP: 'integrated' } });
    const problems = [];
    if (r.exit !== 0) problems.push(`exit ${r.exit}`);
    if (r.timedOut) problems.push('timed out');
    if (expect && !r.expectMatched) problems.push('expected output no longer observed');
    if (r.treeAfter !== r.tree) problems.push('modified the working tree');
    if (problems.length) failures.push(`${label}: ${problems.join(', ')}`);
    const run = { label, cmd, expect, exit: r.exit, expectMatched: r.expectMatched, ok: problems.length === 0, ...extra };
    if (out) {
      run.log = `${String(runs.length + 1).padStart(3, '0')}-${label.replace(/[^\w.-]+/g, '_')}.log`;
      fs.writeFileSync(path.join(out, run.log), logText(cmd, expect, r));
    }
    runs.push(run);
  };

  if (config.commands.test) exec('test', config.commands.test);
  else failures.push('commands.test not configured');
  for (const name of config.style) if (config.commands[name]) exec(`style:${name}`, config.commands[name]);

  for (const f of selected) {
    const state = f.state;
    if (!state.gates.green) continue;
    const ledger = readLedger(f.dir);
    let acs = [];
    try { acs = specInfo(f.dir).acs; } catch (e) { failures.push(`${f.id}: ${e.message}`); }
    for (const ac of acs) {
      const passing = functionalRuns(ledger, f.id, ac.id, state.gates.green.tree).filter((e) => e.exit === 0 && e.expectMatched === true);
      if (!passing.length) { failures.push(`${f.id} ${ac.id}: no passing functional evidence to reproduce`); continue; }
      for (const run of passing) exec(`${f.id} ${ac.id}`, run.cmd, run.expect, { feature: f.id, ac: ac.id, from: run.seq });
    }
  }

  const ok = failures.length === 0;
  const result = { ok, tree, head: head(root), features: selected.map((f) => f.id), failures, runs };
  if (out) {
    writeJson(path.join(out, 'summary.json'), result);
    writeView(root, { out: path.join(out, 'view.html') });
  }
  return result;
}

// Integrates the base branch into a feature that is in progress. The user (or
// the orchestrator) merges or rebases first; this records the new base, so the
// review diff covers only the feature's own changes, and clears every gate
// from green on when the merge changed the code, because the merged tree has
// to be proven again. A merge that changed a locked test is refused unless a
// human relocks those files with a recorded reason.
export function sync(root, ref, { onto, relock = false, by, reason } = {}) {
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  onto ||= state.baseBranch;
  if (!onto) throw new TntError('--onto <ref> is required: the base branch or commit you merged into the feature branch');
  if (state.base === null) throw new TntError(`${f.id}: not started; \`tnt start\` branches from the current base already`);
  if (state.phase === 'done') throw new TntError(`${f.id} is done; check the merged result with \`tnt verify --integrated\` instead`);
  const r = git(root, ['rev-parse', '--verify', '-q', `${onto}^{commit}`], { allowFail: true });
  if (r.status !== 0) throw new TntError(`unknown ref ${onto}`);
  const sha = r.stdout.trim();
  if (git(root, ['merge-base', '--is-ancestor', sha, 'HEAD'], { allowFail: true }).status !== 0) {
    throw new TntError(`${onto} (${sha.slice(0, 10)}) is not merged into HEAD; merge or rebase it first (\`git merge ${onto}\`), resolve conflicts, commit, then sync`);
  }
  if (!isClean(root)) throw new TntError('working tree has uncommitted changes outside .tnt/; commit the merge first');

  let relocked;
  if (state.gates.red && state.locked) {
    const changed = Object.keys(state.locked.files).filter((file) => fileSha(root, file) !== state.locked.files[file]);
    if (changed.length) {
      if (!relock) {
        throw new TntError(`the merge changed locked tests: ${changed.join(', ')}. Check that they still assert the spec, then a human re-locks them: `
          + `tnt sync ${f.id} --onto ${onto} --relock --by "<name>" --reason "<why>"`);
      }
      if (!by || !reason) throw new TntError('--relock needs --by "<human>" and --reason "<why>": re-locking tests is a recorded human decision');
      const missing = changed.filter((file) => fileSha(root, file) === null);
      if (missing.length) throw new TntError(`locked tests deleted by the merge: ${missing.join(', ')}; restore them or \`tnt unlock\``);
      relocked = Object.fromEntries(changed.map((file) => [file, fileSha(root, file)]));
    }
  }

  const tree = treeHash(root);
  const reset = Boolean(state.gates.green && state.gates.green.tree !== tree);
  const e = appendLedger(f.dir, { type: 'sync', feature: f.id, onto: sha, ref: onto, tree, reset, relocked, by: relocked ? by : undefined, reason: relocked ? reason : undefined });
  if (relocked) state.locked = { files: { ...state.locked.files, ...relocked }, seq: state.locked.seq };
  if (reset) { clearFrom(state, 'green'); state.phase = 'red'; }
  state.syncedBase = sha;
  saveState(f.dir, state);
  return { feature: f.id, onto: sha, seq: e.seq, reset, phase: state.phase, relocked: relocked ? Object.keys(relocked) : [] };
}

// ---------------------------------------------------------------- status / report

export function status(root, ref) {
  const config = loadConfig(root);
  const active = readActive(root);
  if (!ref) {
    return {
      project: config.project, active: active?.feature ?? null,
      features: listFeatures(root).map((f) => ({ id: f.id, title: f.state.title, phase: f.state.phase, waivers: f.state.waivers.length })),
    };
  }
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  const next = state.phase === 'done' ? null : GATES[GATES.indexOf(state.phase) + 1] ?? GATES[0];
  let acs = [];
  try { acs = parseAcceptanceCriteria(fs.readFileSync(specPath(f.dir), 'utf8')).map((a) => a.id); } catch { /* draft */ }
  return {
    id: f.id, title: state.title, dir: relPath(root, f.dir), phase: state.phase, nextGate: next,
    started: state.base !== null, base: state.base, baseBranch: state.baseBranch ?? null, syncedBase: state.syncedBase ?? null, branch: state.branch, acs, gates: state.gates, attempts: state.attempts,
    lockedTests: state.locked ? Object.keys(state.locked.files) : [], waivers: state.waivers, unlocks: state.unlocks,
    maxIterations: config.limits.maxIterations, active: active?.feature === f.id,
  };
}

export function writeReport(root, ref) {
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  const ledger = readLedger(f.dir);
  const integrity = verifyLedger(root, f.dir);
  const row = (e) => `| #${e.seq} | ${e.step}${e.name ? ':' + e.name : ''}${e.ac ? ' ' + e.ac : ''} | \`${e.cmd.replace(/\|/g, '\\|').slice(0, 80)}\` | ${e.exit}${e.expect ? (e.expectMatched ? ' ✓expect' : ' ✗expect') : ''} | \`${e.tree.slice(0, 10)}\` | [log](${toPosix(path.relative(f.dir, path.join(root, e.log)))}) |`;
  const lines = [
    `# Evidence report: ${f.id} ${state.title}`, '',
    `Generated by \`tnt report\`. Ledger integrity: **${integrity.ok ? 'intact' : 'BROKEN'}** (${integrity.count} entries).`, '',
    `- Phase: **${state.phase}**`, `- Spec approved by: ${state.approval?.by ?? '—'} (ledger #${state.approval?.seq ?? '—'})`,
    `- Base: \`${state.base || '(root)'}\`  Branch: \`${state.branch ?? '—'}\``,
    `- Locked tests: ${state.locked ? Object.keys(state.locked.files).map((x) => `\`${x}\``).join(', ') : '—'}`, '',
    '## Gates', '', '| Gate | Status | Ledger | Tree |', '|---|---|---|---|',
    ...['spec', 'red', 'green', 'style', 'review', 'functional', 'audit'].map((g) => {
      const s = state.gates[g];
      return `| ${g} | ${s ? (s.waived ? '**WAIVED**' : 'passed') : 'pending'} | ${s ? '#' + s.seq : '—'} | ${s ? '`' + s.tree.slice(0, 10) + '`' : '—'} |`;
    }),
  ];
  if (state.waivers.length) lines.push('', '## Waivers', '', ...state.waivers.map((w) => `- **${w.gate}** waived by ${w.by} (#${w.seq}): ${w.reason}`));
  if (state.unlocks.length) lines.push('', '## Test unlocks', '', ...state.unlocks.map((u) => `- #${u.seq}: ${u.reason}`));
  lines.push('', '## Recorded runs', '', '| Seq | Step | Command | Exit | Tree | Log |', '|---|---|---|---|---|---|', ...ledger.filter((e) => e.type === 'run').map(row));
  const subs = ledger.filter((e) => e.type === 'review' || e.type === 'audit-report');
  if (subs.length) lines.push('', '## Submissions', '', ...subs.map((e) => `- #${e.seq} ${e.type}: **${e.verdict}** (${toPosix(path.relative(f.dir, path.join(root, e.file)))})`));
  const failed = ledger.filter((e) => e.type === 'gate' && !e.pass);
  if (failed.length) lines.push('', '## Failed gate attempts', '', ...failed.map((e) => `- #${e.seq} ${e.gate}: ${e.reasons.join('; ')}`));
  const out = path.join(f.dir, 'report.md');
  fs.writeFileSync(out, lines.join('\n') + '\n');
  return relPath(root, out);
}
