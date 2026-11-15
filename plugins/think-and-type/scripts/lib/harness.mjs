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
  parseSpecExpectations, weakExpectation, withConfigDefaults, PROFILES, REVIEW_CHECKS, gatesOf, reviewsDir, REVIEW_SPEC_TEMPLATE, listReviews,
} from './core.mjs';
import os from 'node:os';

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
  const { feature, featureDir, step, name, ac, cmd, expect, artifacts = [], env = {} } = opts;
  // A review runs every command in its own worktree with the reviewer's config,
  // never in this checkout or with the config of the change under review.
  const { cwd, config } = runtimeOf(root, featureDir);
  if (!cmd || !cmd.trim()) throw new TntError('empty command');
  let expectRe;
  if (expect) {
    try { expectRe = new RegExp(expect, 'm'); } catch (e) { throw new TntError(`--expect is not a valid regex: ${e.message}`); }
  }
  for (const a of artifacts) if (!fs.existsSync(path.resolve(cwd, a))) throw new TntError(`artifact not found: ${a}`);

  const scope = scopeDir(root, featureDir);
  const seq = nextSeq(scope);
  const r = runCommand(cwd, config, { cmd, expectRe, env: { ...env, TNT_FEATURE: feature, TNT_STEP: step } });
  const { tree, treeAfter, head: h, exit, timedOut, durationMs, expectMatched } = r;
  // A functional run (or its re-run by `tnt verify`, recorded as step "audit") is
  // also checked against the approved spec's Expect patterns for its AC, so the
  // gate can tell whether the spec's outcome was observed.
  let specExpect;
  if (ac && featureDir) {
    let patterns = [];
    try { patterns = parseSpecExpectations(fs.readFileSync(specPath(featureDir), 'utf8')).get(ac) ?? []; } catch { /* no spec */ }
    if (patterns.length) specExpect = patterns.map((pattern) => ({ pattern, matched: outputMatches(pattern, r) }));
  }

  const evDir = evidenceDir(root, featureDir);
  fs.mkdirSync(evDir, { recursive: true });
  const stem = [String(seq).padStart(4, '0'), step, name, ac].filter(Boolean).join('-');
  const logAbs = path.join(evDir, `${stem}.log`);
  fs.writeFileSync(logAbs, logText(cmd, expect, r));

  const savedArtifacts = artifacts.map((a, i) => {
    const src = path.resolve(cwd, a);
    const dest = path.join(evDir, `${stem}-artifact${i + 1}-${path.basename(src)}`);
    fs.copyFileSync(src, dest);
    return { source: relPath(cwd, src), path: relPath(root, dest), sha256: sha256(fs.readFileSync(dest)) };
  });

  return appendLedger(scope, {
    type: 'run', feature, step, name, ac, cmd, exit, timedOut, durationMs, tree, treeAfter,
    mutated: tree !== treeAfter, head: h, log: relPath(root, logAbs), logSha256: sha256(fs.readFileSync(logAbs)),
    expect, expectMatched, specExpect, artifacts: savedArtifacts.length ? savedArtifacts : undefined,
  });
}

// Where a scope's commands run and which config chooses them. Features run in
// this checkout with .tnt/config.json. A review runs in its worktree with the
// config snapshot taken from the reviewer's side when the review was created,
// because the change under review must not choose the checks applied to it.
export function runtimeOf(root, featureDir) {
  const state = featureDir && fs.existsSync(path.join(featureDir, 'state.json')) ? loadState(featureDir) : null;
  if (state?.kind !== 'review') return { cwd: root, config: loadConfig(root), review: false };
  if (!state.workdir || !fs.existsSync(state.workdir)) {
    throw new TntError(`${state.id}: the review worktree is missing; run \`tnt start ${state.id}\` to (re)create it`);
  }
  return { cwd: state.workdir, config: trustedConfig(featureDir), review: true };
}

const trustedConfig = (featureDir) => withConfigDefaults(readJson(path.join(featureDir, 'config.json')));

// The config that applies to a feature or review (for choosing commands).
export function configFor(root, f) {
  return f?.dir && f.state?.kind === 'review' ? trustedConfig(f.dir) : loadConfig(root);
}

// Short excerpts of the failing runs a gate's reasons cite (`#seq`), so the
// orchestrator can forward the failure itself instead of sending a step to read
// a whole log. The full log stays the evidence; this is only a pointer into it.
const FAILURE_LINE = /\b(fail(ed|ure|ing|s)?|errors?|exception|assert\w*|expected|actual|traceback|panic(ked)?|not ok)\b|✖|✗/i;
export function excerptLog(text, max = 40) {
  const at = text.indexOf('\n---- stdout ----\n');
  const lines = (at >= 0 ? text.slice(at + 1) : text).split(/\r?\n/).filter((l) => !/^---- std(out|err) ----$/.test(l));
  const keep = new Set();
  lines.forEach((l, i) => { if (FAILURE_LINE.test(l)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j); });
  const picked = keep.size ? [...keep].sort((a, b) => a - b) : lines.map((_, i) => i).filter((l, i) => lines[i].trim()).slice(-25);
  const out = [];
  let prev = -2;
  for (const i of picked) {
    if (out.length >= max) { out.push('…'); break; }
    if (out.length && i !== prev + 1) out.push('…');
    out.push(lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i]);
    prev = i;
  }
  return out;
}

function failureExcerpts(root, ledger, reasons) {
  const out = [];
  const seqs = [...new Set(reasons.flatMap((r) => [...String(r).matchAll(/#(\d+)/g)].map((m) => Number(m[1]))))];
  for (const seq of seqs) {
    const e = ledger.find((x) => x.seq === seq && x.type === 'run' && x.log);
    if (!e || (e.exit === 0 && e.expectMatched !== false)) continue;
    try { out.push({ seq, log: e.log, lines: excerptLog(fs.readFileSync(path.join(root, e.log), 'utf8')) }); } catch { /* log missing: integrity check reports it */ }
    if (out.length >= 3) break;
  }
  return out;
}

function outputMatches(pattern, r) {
  try { return new RegExp(pattern, 'm').test(r.stdout + '\n' + r.stderr); } catch { return false; }
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
const randomId = (prefix = 'F-') => prefix + [...crypto.randomBytes(6)].map((b) => ID_ALPHABET[b % 32]).join('');

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
  return { text, sha: sha256(text), acs: parseAcceptanceCriteria(text), expects: parseSpecExpectations(text) };
}

function specProblems(spec, config, { profile = 'full' } = {}) {
  const p = [];
  if (!spec.acs.length) p.push('spec has no acceptance criteria (lines like "- AC-1: Given ..., when ..., then ...")');
  for (const ac of spec.acs) if (/\.\.\.|<[^>]+>/.test(ac.text)) p.push(`${ac.id} still contains template placeholders`);
  const ids = new Set(spec.acs.map((a) => a.id));
  for (const [ac, patterns] of spec.expects) {
    if (!ids.has(ac)) p.push(`the functional verification plan has an Expect for ${ac}, which is not an acceptance criterion`);
    for (const pattern of patterns) {
      const weak = weakExpectation(pattern);
      if (weak) p.push(`${ac} Expect \`${pattern}\` ${weak}`);
    }
  }
  // The light profile has no functional step, so Expect patterns are optional
  // there (any that are given must still be valid and specific).
  if (config.functional?.requireSpecExpect !== false && profile !== 'light') {
    for (const ac of spec.acs) {
      if (!spec.expects.has(ac.id)) p.push(`${ac.id} has no expected outcome: add "Expect: \`<regex>\`" to its line in the functional verification plan`);
    }
  }
  return p;
}

export function approve(root, ref, { by, profile } = {}) {
  if (!by) throw new TntError('--by "<human name>" is required: approval records who signed off on the spec');
  const f = resolveFeature(root, ref);
  if (profile && f.state.kind === 'review') throw new TntError('--profile applies to features, not reviews');
  profile ||= f.state.profile ?? 'full';
  if (!PROFILES.includes(profile)) throw new TntError(`--profile must be one of ${PROFILES.join(', ')}`);
  const spec = specInfo(f.dir);
  const problems = specProblems(spec, configFor(root, f), { profile });
  if (problems.length) throw new TntError(problems.join('; '));
  const state = loadState(f.dir);
  // A changed spec gets a new set of tests: locks made for the old ACs would
  // otherwise carry over into the next lock-tests and the red gate.
  const droppedLocks = state.approval && state.approval.specSha !== spec.sha && state.locked ? Object.keys(state.locked.files) : undefined;
  const e = appendLedger(f.dir, { type: 'approve', feature: f.id, by, specSha: spec.sha, acs: spec.acs.map((a) => a.id), profile: f.state.kind === 'review' ? undefined : profile, droppedLocks });
  state.approval = { by, seq: e.seq, specSha: spec.sha };
  if (state.kind !== 'review') state.profile = profile;
  if (droppedLocks) delete state.locked;
  saveState(f.dir, state);
  const r = gate(root, f.id, 'spec');
  return droppedLocks ? { ...r, droppedLocks } : r;
}

export function start(root, ref, opts = {}) {
  const f = resolveFeature(root, ref);
  if (f.state.kind === 'review') return startReview(root, f, opts);
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
  featureOnly(f, '`tnt lock-tests`');
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
  featureOnly(f, '`tnt unlock`');
  const state = loadState(f.dir);
  if (!state.gates.red) {
    // Before the red gate a lock is only the set the next red attempt will claim, so
    // there is nothing to reopen: re-lock instead.
    if (state.locked && Object.keys(state.locked.files).length) {
      throw new TntError(`${f.id}: the red gate has not passed, so there is nothing to unlock. To change the locked set (${Object.keys(state.locked.files).join(', ')}), run \`tnt lock-tests ${f.id} <files...> --replace\`, then record a new red run`);
    }
    throw new TntError(`${f.id}: no tests are locked yet; lock them with \`tnt lock-tests ${f.id} <files...>\``);
  }
  const e = appendLedger(f.dir, { type: 'unlock', feature: f.id, reason });
  clearFrom(state, 'red');
  state.phase = 'spec';
  state.unlocks.push({ seq: e.seq, reason });
  saveState(f.dir, state);
  return state;
}

// ---------------------------------------------------------------- gates

function clearFrom(state, g) {
  const list = gatesOf(state);
  for (const x of list.slice(list.indexOf(g))) delete state.gates[x];
}

function featureOnly(f, what) {
  if (f.state.kind === 'review') throw new TntError(`${f.id} is a review of a change built outside tnt; ${what} applies to features only`);
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
    const { state, spec, config } = ctx;
    const p = specProblems(spec, config, { profile: state.profile });
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
    if (run && !state.gates.red.waived && run.tree === state.gates.red.tree) p.push('tests failed and then passed on identical code: the suite is nondeterministic');
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
    const { ledger, tree, f, config } = ctx;
    const p = [];
    const judge = (r, label, how) => {
      if (!r) { p.push(`no ${label} recorded (${how})`); return; }
      if (r.tree !== tree) p.push(`${label} #${r.seq} covers tree ${r.tree.slice(0, 10)}, not the current tree; request a fresh review`);
      if (r.verdict !== 'approve') p.push(`${label} #${r.seq} requested changes (${r.counts.blocking} blocking, ${r.counts.major} major); see ${r.file}`);
    };
    judge(latest(ledger, (e) => e.type === 'review' && e.feature === f.id && !e.source), 'review', '`tnt review submit`');
    if (config.commands.external_review) {
      judge(latest(ledger, (e) => e.type === 'review' && e.feature === f.id && e.source === 'external'), 'external review', '`tnt review external`; commands.external_review is configured');
    }
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
      for (const pattern of spec.expects.get(ac.id) ?? []) {
        if (!runs.some((run) => run.specExpect?.some((x) => x.pattern === pattern && x.matched))) {
          p.push(`${ac.id}: no functional run on the current tree printed the spec's expected outcome /${pattern}/; the approved spec defines what proves this AC`);
        }
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
    // The light profile ends with the re-run alone; no auditor agent judges it.
    if (ctx.state.profile === 'light') return p;
    const a = latest(ledger, (e) => e.type === 'audit-report' && e.feature === f.id);
    if (!a) p.push('no audit report submitted (`tnt audit submit`)');
    else {
      if (a.tree !== tree) p.push(`audit report #${a.seq} covers a different tree`);
      if (a.verdict !== 'pass') p.push(`audit report #${a.seq} verdict is ${a.verdict}; see ${a.file}`);
    }
    return p;
  },
};

// The tree a scope's evidence is judged against: this checkout for a feature,
// the review's worktree for a review (null before it exists).
function scopeTree(root, f) {
  if (f.state?.kind !== 'review') return treeHash(root);
  const wd = loadState(f.dir).workdir;
  return wd && fs.existsSync(wd) ? treeHash(wd) : null;
}

function gateContext(root, f) {
  return {
    root, f, state: loadState(f.dir), config: configFor(root, f), spec: specInfo(f.dir), ledger: readLedger(f.dir), tree: scopeTree(root, f),
  };
}

function preconditions(ctx, g) {
  const { state, spec, tree } = ctx;
  const p = [];
  const list = gatesOf(state);
  const idx = list.indexOf(g);
  for (const prev of list.slice(0, idx)) if (!state.gates[prev]) { p.push(`gate "${prev}" has not passed yet`); return p; }
  if (g !== 'spec') {
    if (!state.approval || state.approval.specSha !== spec.sha) p.push('spec.md changed after approval; re-approve before continuing');
    if (state.base === null) p.push('feature not started (`tnt start`)');
  }
  if (idx > list.indexOf('green') && state.gates.green.tree !== tree) {
    p.push('code changed since the green gate; re-run `tnt run <F> green` and pass the green gate again');
  }
  return p;
}

const COMMIT_ON = { red: (f) => `test(${f.id}): failing acceptance tests [tnt:red]`, green: (f, s) => `feat(${f.id}): ${s.title} [tnt:green]`, audit: (f) => `chore(${f.id}): evidence and report [tnt:done]` };

function evaluate(root, ref, g) {
  const f = resolveFeature(root, ref);
  const list = gatesOf(f.state);
  if (!list.includes(g)) {
    throw new TntError(GATES.includes(g) ? `gate "${g}" is not part of ${f.id}'s light profile (${list.join(' > ')})` : `unknown gate "${g}"; one of ${list.join(', ')}`);
  }
  const ctx = gateContext(root, f);
  let reasons = preconditions(ctx, g);
  if (!reasons.length) reasons = EVALUATORS[g](ctx);
  return { f, ctx, reasons };
}

// Side-effect-free self-check for producer/verifier subagents: no ledger
// entry, no state change, no commit, no attempt counted. Only the
// orchestrator calls `gate`.
export function check(root, ref, g) {
  const rf = resolveFeature(root, ref);
  if (rf.state.kind === 'review') { const { reasons, missing, findings, decided } = reviewEvaluate(root, rf, g); return { feature: rf.id, gate: g, pass: decided && !findings.length, decided, reasons, missing, findings, dryRun: true }; }
  const { f, reasons } = evaluate(root, ref, g);
  return { feature: f.id, gate: g, pass: reasons.length === 0, reasons, dryRun: true };
}

export function gate(root, ref, g) {
  const rf = resolveFeature(root, ref);
  if (rf.state.kind === 'review') return reviewGate(root, rf, g);
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
  const excerpts = pass ? undefined : failureExcerpts(root, ctx.ledger, reasons);
  return { feature: f.id, gate: g, pass, reasons, excerpts, seq: e.seq, phase: state.phase, attempts, maxIterations: ctx.config.limits.maxIterations, commit };
}

export function waive(root, ref, g, { reason, by }) {
  if (!reason || !by) throw new TntError('--reason and --by are required: a waiver is a recorded human decision');
  const f = resolveFeature(root, ref);
  const ctx = gateContext(root, f);
  const list = gatesOf(ctx.state);
  const idx = list.indexOf(g);
  if (idx < 1) throw new TntError(`gate "${g}" cannot be waived`);
  for (const prev of list.slice(0, idx)) if (!ctx.state.gates[prev]) throw new TntError(`gate "${prev}" has not passed yet`);
  const e = appendLedger(f.dir, { type: 'waive', feature: f.id, gate: g, reason, by, tree: ctx.tree });
  const state = loadState(f.dir);
  clearFrom(state, g);
  state.gates[g] = { seq: e.seq, tree: ctx.tree, ts: e.ts, waived: true, pass: true };
  if (state.kind === 'review' && g === 'audit') state.verdict = reviewVerdict(state);
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
  return recordReview(root, f, state, review, scopeTree(root, f), {});
}

// A second, independent review from a command the project configures
// (commands.external_review), typically a different model or vendor, because a
// fresh subagent of the same model shares the producer's blind spots. The
// command gets the diff base, spec and an output path in its environment and
// writes review JSON there; the harness records the run and then checks the JSON
// exactly like an agent's review (quotes must exist, every changed file covered).
export function externalReview(root, ref) {
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  const config = configFor(root, f);
  if (!config.commands.external_review) throw new TntError('commands.external_review is not configured');
  if (!state.gates.style) throw new TntError(`${f.id}: style gate has not passed; review comes after style`);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tnt-review-')), 'review.json');
  const run = execRecorded(root, {
    feature: f.id, featureDir: f.dir, step: 'review', name: 'external', cmd: config.commands.external_review,
    env: { TNT_REVIEW_OUT: out, TNT_BASE: state.syncedBase || state.base || '', TNT_SPEC: path.resolve(specPath(f.dir)), TNT_FEATURE_DIR: path.resolve(f.dir) },
  });
  const fail = (why) => { fs.rmSync(path.dirname(out), { recursive: true, force: true }); throw new TntError(`external review (run #${run.seq}, log ${run.log}): ${why}`); };
  if (run.timedOut) fail('timed out');
  if (run.exit !== 0) fail(`exited ${run.exit}`);
  if (run.mutated) fail('modified the working tree; a review must not change the code it reviews');
  let review;
  try { review = readJson(out); } catch (e) { fail(`wrote no readable review JSON to $TNT_REVIEW_OUT (${e.message})`); }
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return recordReview(root, f, state, review, run.tree, { source: 'external', run: run.seq });
}

function recordReview(root, f, state, review, tree, { source, run }) {
  const errors = [];
  if (!['approve', 'changes_requested'].includes(review.verdict)) errors.push('verdict must be "approve" or "changes_requested"');
  if (!Array.isArray(review.files_reviewed)) errors.push('files_reviewed must be an array of paths');
  if (!Array.isArray(review.findings)) errors.push('findings must be an array (empty if none)');
  if (errors.length) throw new TntError(errors.join('; '));

  // After `tnt sync` the diff starts at the integrated base, so upstream work
  // merged into the branch is not part of this feature's review.
  const changed = changedFiles(root, state.syncedBase || state.base || null, tree);
  // Paths are relative to where the code is: this checkout, or a review's worktree.
  const codeRoot = state.kind === 'review' && state.workdir ? state.workdir : root;
  const reviewed = new Set(review.files_reviewed.map((p) => relPath(codeRoot, p)));
  const missed = changed.filter((c) => !reviewed.has(c));
  if (missed.length) errors.push(`not reviewed: ${missed.join(', ')} (every changed file must be read)`);

  review.findings.forEach((fd, i) => {
    const tag = `finding ${fd.id ?? i + 1}`;
    if (!SEVERITIES.includes(fd.severity)) errors.push(`${tag}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (!fd.issue) errors.push(`${tag}: missing "issue"`);
    if (!fd.file || !Number.isInteger(fd.line) || !fd.quote) { errors.push(`${tag}: needs file, integer line and a verbatim quote`); return; }
    const text = readTreeFile(root, tree, relPath(codeRoot, fd.file));
    if (text === null) { errors.push(`${tag}: ${fd.file} is not in the reviewed tree`); return; }
    const lines = text.split(/\r?\n/);
    const window = normalize(lines.slice(Math.max(0, fd.line - 3), fd.line + 2).join('\n'));
    if (!window.includes(normalize(fd.quote))) errors.push(`${tag}: quote not found near ${fd.file}:${fd.line}; cite code that exists`);
  });
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, review.findings.filter((x) => x.severity === s).length]));
  if (review.verdict === 'approve' && (counts.blocking || counts.major)) errors.push('cannot approve with blocking or major findings');
  if (errors.length) throw new TntError(`${source ? source + ' ' : ''}review rejected:\n  - ${errors.join('\n  - ')}`);

  const seq = nextSeq(f.dir);
  const dest = path.join(f.dir, 'evidence', `${String(seq).padStart(4, '0')}-review${source ? '-' + source : ''}.json`);
  writeJson(dest, review);
  return appendLedger(f.dir, { type: 'review', feature: f.id, source, run, verdict: review.verdict, counts, tree, file: relPath(root, dest), fileSha256: sha256(fs.readFileSync(dest)) });
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
  return appendLedger(f.dir, { type: 'audit-report', feature: f.id, verdict: report.verdict, tree: scopeTree(root, f), file: relPath(root, dest), fileSha256: sha256(fs.readFileSync(dest)) });
}

// ---------------------------------------------------------------- independent re-verification

export function verify(root, ref) {
  const f = resolveFeature(root, ref);
  if (f.state.kind === 'review') return verifyReview(root, f);
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
    return r;
  };
  if (config.commands.test) rerun({ name: 'test', cmd: config.commands.test }, (r) => (r.exit === 0 ? [] : [`exit ${r.exit}`]));
  else failures.push('commands.test not configured');
  for (const name of config.style) if (config.commands[name]) rerun({ name, cmd: config.commands[name] }, (r) => (r.exit === 0 ? [] : [`exit ${r.exit}`]));

  const ledger = readLedger(f.dir);
  let acs = [];
  let expects = new Map();
  try { ({ acs, expects } = specInfo(f.dir)); } catch (e) { failures.push(e.message); }
  const gatedTree = state.gates.green?.tree ?? tree;
  // The light profile records no functional evidence; its proof is the suite.
  for (const ac of state.profile === 'light' ? [] : acs) {
    const runs = functionalRuns(ledger, f.id, ac.id, gatedTree).filter((e) => e.exit === 0 && e.expectMatched === true);
    if (!runs.length) { failures.push(`${ac.id}: no passing functional evidence to reproduce`); continue; }
    const again = runs.map((run) => rerun({ ac: ac.id, name: 'functional', cmd: run.cmd, expect: run.expect }, (r) => [
      ...(r.exit === 0 ? [] : [`exit ${r.exit}`]), ...(r.expectMatched ? [] : ['expected output no longer observed']),
    ]));
    for (const pattern of expects.get(ac.id) ?? []) {
      if (!again.some((r) => r.specExpect?.some((x) => x.pattern === pattern && x.matched))) failures.push(`${ac.id}: re-runs no longer print the spec's expected outcome /${pattern}/`);
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
    return r;
  };

  if (config.commands.test) exec('test', config.commands.test);
  else failures.push('commands.test not configured');
  for (const name of config.style) if (config.commands[name]) exec(`style:${name}`, config.commands[name]);

  for (const f of selected) {
    const state = f.state;
    if (!state.gates.green || state.profile === 'light') continue; // light features have no functional evidence
    const ledger = readLedger(f.dir);
    let acs = [];
    let expects = new Map();
    try { ({ acs, expects } = specInfo(f.dir)); } catch (e) { failures.push(`${f.id}: ${e.message}`); }
    for (const ac of acs) {
      const passing = functionalRuns(ledger, f.id, ac.id, state.gates.green.tree).filter((e) => e.exit === 0 && e.expectMatched === true);
      if (!passing.length) { failures.push(`${f.id} ${ac.id}: no passing functional evidence to reproduce`); continue; }
      const again = passing.map((run) => exec(`${f.id} ${ac.id}`, run.cmd, run.expect, { feature: f.id, ac: ac.id, from: run.seq }));
      for (const pattern of expects.get(ac.id) ?? []) {
        if (!again.some((r) => outputMatches(pattern, r))) failures.push(`${f.id} ${ac.id}: the spec's expected outcome /${pattern}/ is no longer printed`);
      }
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
  featureOnly(f, '`tnt sync`');
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

// ---------------------------------------------------------------- reviews of changes built outside tnt
//
// A review proves what someone else's change does with the same evidence
// machinery as a feature, but the reviewer never changes the code. A check is
// *decided* once its evidence is complete: it passes, or it records findings
// against the change, and the flow moves on, so a failing pull request still
// gets a full review. A check stays *undecided* while its evidence is missing or
// invalid (not run, run on other code, timed out), and the gate exits 1.

function defaultBaseRef(root) {
  const r = git(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  for (const b of ['main', 'master']) if (git(root, ['rev-parse', '--verify', '-q', `${b}^{commit}`], { allowFail: true }).status === 0) return b;
  throw new TntError('--base <ref> is required: the branch the change will merge into');
}

function commitOf(root, ref) {
  const r = git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true });
  if (r.status !== 0) throw new TntError(`unknown ref ${ref}; fetch it first (for a pull request: git fetch origin pull/<n>/head)`);
  return r.stdout.trim();
}

// Files that steer AI agents working in the repository. A change to them is not
// wrong in itself, but a reviewer should see it, because it affects every later
// session in the repo.
const AGENT_CONFIG = ['.claude', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', '.cursor', '.cursorrules', '.github/copilot-instructions.md'];

// The config a review applies comes from the side doing the checking: the base
// commit's .tnt/config.json, or this checkout's when the base has none. Never the
// change's own, which could otherwise pick the commands that check it.
function trustedConfigText(root, baseCommit, { local = false } = {}) {
  if (local) return { text: fs.readFileSync(configPath(root), 'utf8'), source: `this checkout's ${TNT_DIR}/config.json (--local-config)` };
  const r = git(root, ['show', `${baseCommit}:${TNT_DIR}/config.json`], { allowFail: true });
  if (r.status === 0) {
    try { JSON.parse(r.stdout); return { text: r.stdout, source: `${TNT_DIR}/config.json at the base commit ${baseCommit.slice(0, 10)}` }; } catch { /* fall through */ }
  }
  return { text: fs.readFileSync(configPath(root), 'utf8'), source: `this checkout's ${TNT_DIR}/config.json (the base commit has none)` };
}

const changedPaths = (root, from, to, paths) => git(root, ['diff', '--name-only', from, to, '--', ...paths], { allowFail: true }).stdout
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

export function newReview(root, title, { target, base, headOnly = false, localConfig = false } = {}) {
  if (!title || !title.trim()) throw new TntError('review title required');
  if (!target) throw new TntError('--target <ref> is required: the branch, commit or fetched pull request head to review');
  const commit = commitOf(root, target);
  const baseRef = base || defaultBaseRef(root);
  const baseCommit = commitOf(root, baseRef);
  const mb = git(root, ['merge-base', baseCommit, commit], { allowFail: true });
  if (mb.status !== 0) throw new TntError(`${target} and ${baseRef} share no history`);
  const mergeBase = mb.stdout.trim();
  const taken = new Set(listReviews(root).map((r) => r.id));
  let id;
  do id = randomId('R-'); while (taken.has(id));
  const dir = path.join(reviewsDir(root), `${id}-${slugify(title)}`);
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  ensureLocalIgnores(root);
  const trusted = trustedConfigText(root, baseCommit, { local: localConfig });
  fs.writeFileSync(path.join(dir, 'config.json'), trusted.text);
  const t = { ref: target, commit, baseRef };
  fs.writeFileSync(specPath(dir), REVIEW_SPEC_TEMPLATE(id, title.trim(), t));
  const mode = headOnly ? 'head' : 'merge';
  const tntChanges = changedPaths(root, mergeBase, commit, [TNT_DIR]);
  const agentChanges = changedPaths(root, mergeBase, commit, AGENT_CONFIG);
  const state = {
    kind: 'review', id, title: title.trim(), created: new Date().toISOString(), phase: 'draft', gates: {}, attempts: {},
    approval: null, target: t, mode, baseCommit, mergeBase, base: mode === 'merge' ? baseCommit : mergeBase,
    configSource: trusted.source, configSha: sha256(trusted.text), tntChanges, agentChanges, mergeConflict: null,
    workdir: null, tree: null, verdict: null, locked: null, syncedBase: null, branch: null, unlocks: [], waivers: [],
  };
  saveState(dir, state);
  appendLedger(dir, {
    type: 'review-created', feature: id, title: title.trim(), target, commit, baseRef, baseCommit, mergeBase, mode,
    configSource: trusted.source, configSha: state.configSha, tntChanges, agentChanges,
  });
  return { id, dir: relPath(root, dir), commit, base: state.base, baseRef, mode, configSource: trusted.source, tntChanges, agentChanges };
}

function removeWorktree(root, wd) {
  if (!wd) return;
  git(root, ['worktree', 'remove', '--force', wd], { allowFail: true });
  fs.rmSync(wd, { recursive: true, force: true });
  git(root, ['worktree', 'prune'], { allowFail: true });
}

// Builds the code under review in a temporary worktree outside this checkout:
// the change merged into its base (what would ship), or with --head-only the
// change's own commit. Your branch, working tree and .claude/ settings are never
// touched, and nothing from the change runs in the folder of your session.
function startReview(root, f, { headOnly = false } = {}) {
  const state = loadState(f.dir);
  if (!state.gates.spec) throw new TntError(`${f.id}: the claims in spec.md are not approved yet`);
  if (headOnly && state.mode !== 'head') {
    if (state.tree) throw new TntError(`${f.id} was started on the merge result; create a new review with --head-only to review the change's own commit`);
    state.mode = 'head';
    state.base = state.mergeBase;
    appendLedger(f.dir, { type: 'review-mode', feature: f.id, mode: 'head', base: state.base });
    saveState(f.dir, state);
  }
  if (state.tree && state.workdir && fs.existsSync(state.workdir)) {
    return { feature: f.id, kind: 'review', alreadyStarted: true, commit: state.target.commit, mode: state.mode, tree: state.tree, workdir: state.workdir };
  }
  removeWorktree(root, state.workdir);
  const wd = path.join(os.tmpdir(), `tnt-${f.id}-${crypto.randomBytes(4).toString('hex')}`);
  git(root, ['worktree', 'add', '--detach', wd, state.mode === 'head' ? state.target.commit : state.baseCommit]);
  if (state.mode === 'merge') {
    const m = git(wd, ['-c', 'user.name=tnt review', '-c', 'user.email=tnt-review@localhost', '-c', 'commit.gpgsign=false',
      'merge', '--no-ff', '--no-edit', '--no-verify', state.target.commit], { allowFail: true });
    if (m.status !== 0) {
      const files = git(wd, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).stdout.split(/\r?\n/).filter(Boolean);
      removeWorktree(root, wd);
      if (!state.mergeConflict) {
        state.mergeConflict = files;
        state.workdir = null;
        saveState(f.dir, state);
        appendLedger(f.dir, { type: 'merge-conflict', feature: f.id, baseCommit: state.baseCommit, commit: state.target.commit, files });
      }
      throw new TntError(`the change does not merge cleanly into ${state.target.baseRef} (${files.join(', ') || 'merge failed'}). `
        + `That is recorded as a finding. To review the change's own commit instead, run \`tnt start ${f.id} --head-only\``);
    }
  }
  state.workdir = wd;
  saveState(f.dir, state);
  const config = trustedConfig(f.dir);
  if (config.review?.setup) {
    const run = execRecorded(root, { feature: f.id, featureDir: f.dir, step: 'setup', cmd: config.review.setup });
    if (run.exit !== 0 || run.timedOut || run.mutated) {
      throw new TntError(`review.setup ${run.mutated ? 'modified tracked files' : run.timedOut ? 'timed out' : `exited ${run.exit}`} (run #${run.seq}, log ${run.log}); fix it and run \`tnt start ${f.id}\` again`);
    }
  }
  const tree = treeHash(wd);
  const recreated = Boolean(state.tree);
  if (recreated && tree !== state.tree) {
    throw new TntError(`the recreated worktree holds different code (${tree.slice(0, 10)}) from the code under review (${state.tree.slice(0, 10)})`);
  }
  state.tree = tree;
  saveState(f.dir, state);
  appendLedger(f.dir, { type: 'start', feature: f.id, commit: state.target.commit, mode: state.mode, base: state.base, tree, recreated: recreated || undefined });
  return { feature: f.id, kind: 'review', commit: state.target.commit, mode: state.mode, tree, workdir: wd, recreated };
}

// Removes a review's worktree. The evidence stays; `tnt start <R>` rebuilds the
// same code if it is needed again (for example to re-run `tnt verify`).
export function closeReview(root, ref) {
  const f = resolveFeature(root, ref);
  if (f.state.kind !== 'review') throw new TntError(`${f.id} is not a review`);
  const state = loadState(f.dir);
  removeWorktree(root, state.workdir);
  state.workdir = null;
  saveState(f.dir, state);
  return { feature: f.id, closed: true };
}

const REVIEW_EVALUATORS = {
  spec: (ctx) => ({ missing: EVALUATORS.spec(ctx), findings: [] }),
  tests({ ledger, tree, f, config }) {
    if (!config.commands.test) return { missing: ['commands.test is not configured'], findings: [] };
    const run = latest(ledger, (e) => e.type === 'run' && e.feature === f.id && e.step === 'tests');
    const missing = runIssues(run, tree, 'tests');
    const findings = !missing.length && run.exit !== 0 ? [`the test suite fails on this change (run #${run.seq}, exit ${run.exit}); see ${run.log}`] : [];
    return { missing, findings };
  },
  style({ ledger, tree, f, config }) {
    if (!config.style.length) return { missing: ['config.style is empty, so there is no style check to run; waive the check if the project has none'], findings: [] };
    const missing = [];
    const findings = [];
    for (const name of config.style) {
      if (!config.commands[name]) { missing.push(`commands.${name} is not configured`); continue; }
      const run = latest(ledger, (e) => e.type === 'run' && e.feature === f.id && e.step === 'style' && e.name === name && e.tree === tree);
      const m = runIssues(run, tree, `style:${name}`);
      missing.push(...m);
      if (!m.length && run.exit !== 0) findings.push(`style:${name} fails on this change (run #${run.seq}, exit ${run.exit}); see ${run.log}`);
    }
    return { missing, findings };
  },
  review({ ledger, tree, f, config, state }) {
    const missing = [];
    // Findings the harness adds itself, so no reviewer can miss them.
    const findings = [];
    if (state.tntChanges?.length) findings.push(`blocking: the change modifies tnt's own files (${state.tntChanges.join(', ')}). The review ignored them and applied ${state.configSource}; a change under review must not alter how it is checked`);
    if (state.mergeConflict) findings.push(`blocking: the change does not merge cleanly into ${state.target.baseRef} (${state.mergeConflict.join(', ')}); this review covers the change's own commit`);
    const judge = (r, label, how) => {
      if (!r) missing.push(`no ${label} recorded (${how})`);
      else if (r.tree !== tree) missing.push(`${label} #${r.seq} covers other code; review again`);
      else if (r.verdict !== 'approve') findings.push(`${label} #${r.seq} requested changes (${r.counts.blocking} blocking, ${r.counts.major} major, ${r.counts.minor} minor); see ${r.file}`);
    };
    judge(latest(ledger, (e) => e.type === 'review' && e.feature === f.id && !e.source), 'review', '`tnt review submit`');
    if (config.commands.external_review) {
      judge(latest(ledger, (e) => e.type === 'review' && e.feature === f.id && e.source === 'external'), 'external review', '`tnt review external`; commands.external_review is configured');
    }
    return { missing, findings };
  },
  functional({ spec, ledger, tree, f }) {
    const missing = [];
    const findings = [];
    for (const ac of spec.acs) {
      const runs = functionalRuns(ledger, f.id, ac.id, tree);
      if (!runs.length) { missing.push(`${ac.id}: no functional evidence recorded`); continue; }
      const broken = runs.flatMap((run) => runIssues(run, tree, `functional ${ac.id}`));
      if (broken.length) { missing.push(...broken); continue; }
      for (const run of runs) {
        if (run.exit !== 0) findings.push(`${ac.id}: functional run #${run.seq} exited ${run.exit}; see ${run.log}`);
        else if (run.expectMatched !== true) findings.push(`${ac.id}: functional run #${run.seq} did not show /${run.expect}/; see ${run.log}`);
      }
      for (const pattern of spec.expects.get(ac.id) ?? []) {
        if (!runs.some((run) => run.specExpect?.some((x) => x.pattern === pattern && x.matched))) findings.push(`${ac.id}: the claimed outcome /${pattern}/ was not observed in any functional run`);
      }
    }
    return { missing, findings };
  },
  audit({ ledger, tree, f }) {
    const missing = [];
    const findings = [];
    const v = latest(ledger, (e) => e.type === 'verify' && e.feature === f.id);
    if (!v) missing.push('no `tnt verify` recorded');
    else if (v.tree !== tree) missing.push(`verify #${v.seq} ran on other code`);
    else if (!v.ok) {
      const ledgerProblems = v.failures.filter((x) => x.startsWith('ledger'));
      if (ledgerProblems.length) missing.push(`verify #${v.seq}: ${ledgerProblems.join('; ')}`);
      else findings.push(`the evidence did not reproduce (verify #${v.seq}): ${v.failures.join('; ')}`);
    }
    const a = latest(ledger, (e) => e.type === 'audit-report' && e.feature === f.id);
    if (!a) missing.push('no audit report submitted (`tnt audit submit`)');
    else if (a.tree !== tree) missing.push(`audit report #${a.seq} covers other code`);
    else if (a.verdict !== 'pass') findings.push(`the audit found that the evidence does not support the checks (#${a.seq}); see ${a.file}`);
    return { missing, findings };
  },
};

function reviewEvaluate(root, f, g) {
  if (!REVIEW_CHECKS.includes(g)) throw new TntError(`unknown check "${g}" for a review; one of ${REVIEW_CHECKS.join(', ')}`);
  const ctx = gateContext(root, f);
  const { state, spec, tree } = ctx;
  const out = (missing, findings = []) => ({ ctx, missing, findings, decided: missing.length === 0, reasons: missing.length ? missing : findings });
  for (const prev of REVIEW_CHECKS.slice(0, REVIEW_CHECKS.indexOf(g))) if (!state.gates[prev]) return out([`check "${prev}" has not been decided yet`]);
  if (g !== 'spec') {
    const p = [];
    if (!state.approval || state.approval.specSha !== spec.sha) p.push('spec.md changed after approval; re-approve');
    if (!state.tree) p.push(`review not started: check out ${state.target.commit.slice(0, 10)} and run \`tnt start ${f.id}\``);
    else if (state.tree !== tree) p.push(`the working tree is not the change under review (${state.target.commit.slice(0, 10)}); check it out again with no local edits`);
    if (p.length) return out(p);
  }
  const { missing, findings } = REVIEW_EVALUATORS[g](ctx);
  return out(missing, findings);
}

const reviewVerdict = (state) => (REVIEW_CHECKS.every((g) => state.gates[g]?.pass) ? 'approve' : 'changes_requested');

function reviewGate(root, f, g) {
  const { ctx, missing, findings, decided, reasons } = reviewEvaluate(root, f, g);
  const pass = decided && findings.length === 0;
  const e = appendLedger(f.dir, {
    type: 'gate', feature: f.id, gate: g, pass, decided, tree: ctx.tree,
    reasons: missing.length ? missing : undefined, findings: findings.length ? findings : undefined,
  });
  const state = loadState(f.dir);
  if (decided) {
    clearFrom(state, g);
    state.gates[g] = { seq: e.seq, tree: ctx.tree, ts: e.ts, pass, findings: findings.length ? findings : undefined };
    state.phase = g === 'audit' ? 'done' : g;
    state.attempts[g] = 0;
    state.verdict = g === 'audit' ? reviewVerdict(state) : null;
  } else {
    state.attempts[g] = (state.attempts[g] || 0) + 1;
  }
  if (decided && g === 'audit') { removeWorktree(root, state.workdir); state.workdir = null; }
  saveState(f.dir, state);
  if (decided && g === 'audit') writeReport(root, f.id);
  return {
    feature: f.id, gate: g, kind: 'review', decided, pass, reasons, missing, findings, seq: e.seq, phase: state.phase,
    excerpts: pass ? undefined : failureExcerpts(root, ctx.ledger, reasons),
    attempts: state.attempts[g], maxIterations: ctx.config.limits.maxIterations, verdict: state.verdict, commit: null,
  };
}

// Re-runs every recorded command of a review on the same code and checks that
// each reproduces its recorded outcome. A failing run that fails again is
// reproduced; a run whose outcome flips is flaky evidence, and that is a finding.
function verifyReview(root, f) {
  const state = loadState(f.dir);
  const { cwd, config } = runtimeOf(root, f.dir);
  const failures = verifyLedger(root, f.dir).errors.map((e) => `ledger: ${e}`);
  if (sha256(fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8')) !== state.configSha) failures.push('the review config snapshot was edited after the review was created');
  const tree = treeHash(cwd);
  if (!state.tree) failures.push('review not started');
  else if (state.tree !== tree) failures.push('the working tree is not the change under review');
  const ledger = readLedger(f.dir);
  const reruns = [];
  const redo = (label, orig) => {
    if (!orig) { failures.push(`${label}: nothing recorded to reproduce`); return; }
    const r = execRecorded(root, { feature: f.id, featureDir: f.dir, step: 'audit', name: orig.name ?? orig.step, ac: orig.ac, cmd: orig.cmd, expect: orig.expect });
    reruns.push(r.seq);
    const p = [];
    if ((orig.exit === 0) !== (r.exit === 0)) p.push(`recorded exit ${orig.exit}, re-run exit ${r.exit}`);
    if (orig.expect && orig.expectMatched !== r.expectMatched) p.push(`/${orig.expect}/ ${orig.expectMatched ? 'no longer' : 'now'} observed`);
    for (const x of orig.specExpect ?? []) {
      const y = r.specExpect?.find((z) => z.pattern === x.pattern);
      if (y && y.matched !== x.matched) p.push(`claimed outcome /${x.pattern}/ ${x.matched ? 'no longer' : 'now'} observed`);
    }
    if (r.mutated) p.push('modified the working tree');
    if (p.length) failures.push(`${label} (#${orig.seq}, re-run #${r.seq}): ${p.join(', ')}`);
  };
  const t = state.tree;
  const isRun = (e) => e.type === 'run' && e.feature === f.id && e.tree === t;
  if (!state.gates.tests?.waived) redo('tests', latest(ledger, (e) => isRun(e) && e.step === 'tests'));
  if (!state.gates.style?.waived) for (const name of config.style) if (config.commands[name]) redo(`style:${name}`, latest(ledger, (e) => isRun(e) && e.step === 'style' && e.name === name));
  let acs = [];
  try { acs = specInfo(f.dir).acs; } catch (e) { failures.push(e.message); }
  for (const ac of acs) for (const run of functionalRuns(ledger, f.id, ac.id, t)) redo(`functional ${ac.id}`, run);
  const ok = failures.length === 0;
  const e = appendLedger(f.dir, { type: 'verify', feature: f.id, ok, tree, reruns, failures });
  return { ok, failures, seq: e.seq, reruns };
}

function reviewStatus(root, f, state, config) {
  const next = state.phase === 'done' ? null : REVIEW_CHECKS[REVIEW_CHECKS.indexOf(state.phase) + 1] ?? REVIEW_CHECKS[0];
  let acs = [];
  try { acs = specInfo(f.dir).acs.map((a) => a.id); } catch { /* draft */ }
  return {
    id: f.id, kind: 'review', title: state.title, dir: relPath(root, f.dir), phase: state.phase, nextGate: next, checks: REVIEW_CHECKS,
    started: Boolean(state.tree), target: state.target, base: state.base, mode: state.mode, workdir: state.workdir ?? null,
    configSource: state.configSource, tntChanges: state.tntChanges ?? [], agentChanges: state.agentChanges ?? [], mergeConflict: state.mergeConflict ?? null, syncedBase: null, acs, gates: state.gates, attempts: state.attempts,
    verdict: state.verdict ?? null, lockedTests: [], waivers: state.waivers, unlocks: [], maxIterations: config.limits.maxIterations,
  };
}

// ---------------------------------------------------------------- status / report

export function status(root, ref) {
  const config = loadConfig(root);
  const active = readActive(root);
  if (!ref) {
    return {
      project: config.project, active: active?.feature ?? null,
      features: listFeatures(root).map((f) => ({ id: f.id, title: f.state.title, phase: f.state.phase, waivers: f.state.waivers.length })),
      reviews: listReviews(root).map((f) => ({ id: f.id, title: f.state.title, phase: f.state.phase, verdict: f.state.verdict ?? null })),
    };
  }
  const f = resolveFeature(root, ref);
  const state = loadState(f.dir);
  if (state.kind === 'review') return reviewStatus(root, f, state, config);
  const list = gatesOf(state);
  const next = state.phase === 'done' ? null : list[list.indexOf(state.phase) + 1] ?? list[0];
  let acs = [];
  try { acs = parseAcceptanceCriteria(fs.readFileSync(specPath(f.dir), 'utf8')).map((a) => a.id); } catch { /* draft */ }
  return {
    id: f.id, title: state.title, dir: relPath(root, f.dir), phase: state.phase, nextGate: next, profile: state.profile ?? 'full', gateList: list,
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
  const review = state.kind === 'review';
  const lines = [
    `# ${review ? 'Review' : 'Evidence'} report: ${f.id} ${state.title}`, '',
    `Generated by \`tnt report\`. Ledger integrity: **${integrity.ok ? 'intact' : 'BROKEN'}** (${integrity.count} entries).`, '',
    `- Phase: **${state.phase}**`, `- ${review ? 'Claims' : 'Spec'} approved by: ${state.approval?.by ?? '—'} (ledger #${state.approval?.seq ?? '—'})`,
    ...(state.profile === 'light' ? ['- Profile: **light**, chosen at approval: no code review, functional or audit agents; `tnt verify` re-ran the suite and style checks'] : []),
    ...(review ? [
      `- Change: \`${state.target.ref}\` at \`${state.target.commit}\`, against \`${state.target.baseRef}\``,
      `- Reviewed: ${state.mode === 'head' ? `the change's own commit (diff from merge base \`${state.base}\`)` : `the change merged into \`${state.target.baseRef}\` at \`${state.baseCommit}\` (what would ship)`}`,
      `- Config applied: ${state.configSource} (sha256 \`${String(state.configSha).slice(0, 12)}\`)`,
      ...(state.tntChanges?.length ? [`- **The change modifies tnt files, which the review ignored:** ${state.tntChanges.map((x) => `\`${x}\``).join(', ')}`] : []),
      ...(state.agentChanges?.length ? [`- The change modifies AI agent configuration: ${state.agentChanges.map((x) => `\`${x}\``).join(', ')}`] : []),
      `- Verdict: **${state.verdict ? state.verdict.replace('_', ' ').toUpperCase() : 'pending'}**`,
    ] : [
      `- Base: \`${state.base || '(root)'}\`  Branch: \`${state.branch ?? '—'}\``,
      `- Locked tests: ${state.locked ? Object.keys(state.locked.files).map((x) => `\`${x}\``).join(', ') : '—'}`,
    ]), '',
    `## ${review ? 'Checks' : 'Gates'}`, '', `| ${review ? 'Check' : 'Gate'} | Status | Ledger | Tree |`, '|---|---|---|---|',
    ...gatesOf(state).map((g) => {
      const s = state.gates[g];
      const st = !s ? 'pending' : s.waived ? '**WAIVED**' : s.pass === false ? '**FINDINGS**' : 'passed';
      return `| ${g} | ${st} | ${s ? '#' + s.seq : '—'} | ${s?.tree ? '`' + s.tree.slice(0, 10) + '`' : '—'} |`;
    }),
  ];
  if (review) {
    const found = gatesOf(state).flatMap((g) => (state.gates[g]?.findings ?? []).map((x) => `- **${g}**: ${x}`));
    if (found.length) lines.push('', '## Findings', '', ...found);
    const reviews = ledger.filter((e) => e.type === 'review' && e.tree === state.tree);
    const latestBySource = [...new Map(reviews.map((e) => [e.source ?? 'agent', e])).values()];
    const items = latestBySource.flatMap((e) => {
      try { return (readJson(path.join(root, e.file)).findings ?? []).map((x) => `- ${x.severity} \`${x.file}:${x.line}\`${e.source ? ` (${e.source})` : ''}: ${x.issue}`); } catch { return []; }
    });
    if (items.length) lines.push('', '## Code review findings', '', ...items);
  }
  if (state.waivers.length) lines.push('', '## Waivers', '', ...state.waivers.map((w) => `- **${w.gate}** waived by ${w.by} (#${w.seq}): ${w.reason}`));
  if (state.unlocks.length) lines.push('', '## Test unlocks', '', ...state.unlocks.map((u) => `- #${u.seq}: ${u.reason}`));
  lines.push('', '## Recorded runs', '', '| Seq | Step | Command | Exit | Tree | Log |', '|---|---|---|---|---|---|', ...ledger.filter((e) => e.type === 'run').map(row));
  const subs = ledger.filter((e) => e.type === 'review' || e.type === 'audit-report');
  if (subs.length) lines.push('', '## Submissions', '', ...subs.map((e) => `- #${e.seq} ${e.type}${e.source ? ` (${e.source})` : ''}: **${e.verdict}** (${toPosix(path.relative(f.dir, path.join(root, e.file)))})`));
  const failed = ledger.filter((e) => e.type === 'gate' && !e.pass && e.reasons);
  if (failed.length) lines.push('', `## ${review ? 'Undecided check attempts' : 'Failed gate attempts'}`, '', ...failed.map((e) => `- #${e.seq} ${e.gate}: ${e.reasons.join('; ')}`));
  const out = path.join(f.dir, 'report.md');
  fs.writeFileSync(out, lines.join('\n') + '\n');
  return relPath(root, out);
}
