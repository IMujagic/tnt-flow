// Core primitives for the think-and-type harness: git tree hashing, the
// hash-chained evidence ledger, config, feature state and spec parsing.
// Zero dependencies; Node >= 18.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const TNT_DIR = '.tnt';
export const GATES = ['spec', 'red', 'green', 'style', 'review', 'functional', 'audit'];
export const PROJECT_FEATURE = '_project';
// Feature ids: "F-" plus uppercase letters and digits, no further "-" (the
// directory is "<id>-<slug>"). New ids are random so developers who plan on
// different branches never mint the same one.
export const FEATURE_ID = /^F-[0-9A-Z]+$/;
const FEATURE_DIR = /^(F-[0-9A-Z]+)(?=-|$)/;
// Reviews of changes built outside tnt (someone else's pull request): "R-" ids,
// their own directory and their own checks. A check is decided with a pass or
// with findings against the change; it is never "fixed" by the reviewer.
export const REVIEW_ID = /^R-[0-9A-Z]+$/;
const REVIEW_DIR = /^(R-[0-9A-Z]+)(?=-|$)/;
export const REVIEW_CHECKS = ['spec', 'tests', 'style', 'review', 'functional', 'audit'];
export const gatesOf = (state) => (state.kind === 'review' ? REVIEW_CHECKS : GATES);

export class TntError extends Error {}

export const toPosix = (p) => p.split(path.sep).join('/');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
      .join(',') + '}';
  }
  return JSON.stringify(v);
}

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------- git

export function git(root, args, { env, allowFail = false } = {}) {
  const r = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', env: env ?? process.env, maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw new TntError(`git is not available: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new TntError(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function gitToplevel(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? path.resolve(r.stdout.trim()) : null;
}

export function head(root) {
  const r = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Content hash of the working tree (tracked + untracked, honouring
// .gitignore, excluding .tnt/). Independent of commits, so evidence
// stays bound to the exact code it was produced against.
export function treeHash(root) {
  const tmp = path.join(os.tmpdir(), `tnt-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const realIndex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).stdout.trim());
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmp);
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    git(root, ['add', '-A', '--', '.', `:(exclude)${TNT_DIR}`], { env });
    git(root, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', TNT_DIR], { env });
    return git(root, ['write-tree'], { env }).stdout.trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function isClean(root) {
  const r = git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${TNT_DIR}`]);
  return r.stdout.trim() === '';
}

export function changedFiles(root, base, tree) {
  // Added/modified/renamed files only (deletions cannot be quoted), never harness files.
  const out = base
    ? git(root, ['diff', '--name-only', '--diff-filter=ACMRT', base, tree]).stdout
    : git(root, ['ls-tree', '-r', '--name-only', tree]).stdout;
  return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith(TNT_DIR + '/'));
}

export function readTreeFile(root, tree, file) {
  const r = git(root, ['cat-file', '-p', `${tree}:${file}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

export function commitAll(root, message) {
  git(root, ['add', '-A']);
  if (git(root, ['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) return null;
  const r = git(root, ['commit', '-q', '-m', message], { allowFail: true });
  if (r.status !== 0) return { error: (r.stderr || r.stdout).trim() };
  return { sha: head(root) };
}

// ---------------------------------------------------------------- root/config

export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, TNT_DIR, 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireRoot(start) {
  const root = findRoot(start);
  if (!root) throw new TntError(`No ${TNT_DIR}/config.json found. Run \`tnt init\` in the project root first.`);
  if (fs.existsSync(path.join(root, TNT_DIR, 'ledger.jsonl'))) {
    throw new TntError(`${TNT_DIR}/ledger.jsonl is the single shared ledger from tnt 0.1, which conflicts whenever two branches merge. `
      + `This version keeps one ledger per feature. Move ${TNT_DIR}/ aside and run \`tnt init\` to start a fresh audit trail (git history keeps the old one).`);
  }
  return root;
}

export const DEFAULT_CONFIG = {
  version: 1,
  project: { name: '', type: 'existing' },
  commands: { test: null, lint: null, format_check: null, typecheck: null, build: null, external_review: null },
  style: [],
  functional: { requireSpecExpect: true },
  review: { setup: null },
  git: { autoCommit: true, branchPerFeature: true, branchPrefix: 'tnt/' },
  red: { requireAcInOutput: true },
  limits: { maxIterations: 3 },
  timeouts: { commandMs: 900000 },
  shell: null,
};

function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

export const configPath = (root) => path.join(root, TNT_DIR, 'config.json');
export const withConfigDefaults = (config) => deepMerge(DEFAULT_CONFIG, config);
export function loadConfig(root) {
  return withConfigDefaults(readJson(configPath(root)));
}

// ---------------------------------------------------------------- ledger
//
// One hash chain per scope: each feature directory has its own ledger.jsonl,
// and project-wide events (init, baseline, project probes) live in
// .tnt/_project/. A feature is developed on one branch, so two branches never
// append to the same file and merges don't conflict. Ordering across features
// comes from git history, whose commits include each ledger.

export const projectDir = (root) => path.join(root, TNT_DIR, PROJECT_FEATURE);
export const scopeDir = (root, featureDir) => featureDir ?? projectDir(root);
export const ledgerPath = (dir) => path.join(dir, 'ledger.jsonl');

export function readLedger(dir) {
  const p = ledgerPath(dir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new TntError(`${p}: line ${i + 1} is not valid JSON`); }
  });
}

export function nextSeq(dir) {
  const l = readLedger(dir);
  return l.length ? l[l.length - 1].seq + 1 : 1;
}

export function appendLedger(dir, entry) {
  const ledger = readLedger(dir);
  const last = ledger[ledger.length - 1];
  const body = { ...entry, seq: last ? last.seq + 1 : 1, ts: new Date().toISOString(), prev: last ? last.hash : 'GENESIS' };
  const full = { ...body, hash: sha256(stableStringify(body)) };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerPath(dir), JSON.stringify(full) + '\n');
  return full;
}

export function verifyLedger(root, dir) {
  const errors = [];
  let prev = 'GENESIS';
  let ledger;
  try { ledger = readLedger(dir); } catch (e) { return { ok: false, errors: [e.message], count: 0 }; }
  ledger.forEach((e, i) => {
    const { hash, ...body } = e;
    if (e.seq !== i + 1) errors.push(`entry ${i + 1}: seq is ${e.seq}`);
    if (e.prev !== prev) errors.push(`entry ${e.seq}: chain broken (prev mismatch)`);
    if (sha256(stableStringify(body)) !== hash) errors.push(`entry ${e.seq}: content hash mismatch (entry was edited)`);
    const files = [];
    if (e.log) files.push([e.log, e.logSha256]);
    if (e.file) files.push([e.file, e.fileSha256]);
    for (const a of e.artifacts || []) files.push([a.path, a.sha256]);
    for (const [f, want] of files) {
      const abs = path.join(root, f);
      if (!fs.existsSync(abs)) errors.push(`entry ${e.seq}: evidence file missing: ${f}`);
      else if (sha256(fs.readFileSync(abs)) !== want) errors.push(`entry ${e.seq}: evidence file altered: ${f}`);
    }
    prev = hash;
  });
  return { ok: errors.length === 0, errors, count: ledger.length };
}

// Every ledger in the project: _project plus one per feature and per review.
export function verifyAllLedgers(root) {
  const scopes = [{ scope: PROJECT_FEATURE, dir: projectDir(root) }, ...[...listFeatures(root), ...listReviews(root)].map((f) => ({ scope: f.id, dir: f.dir }))];
  const ledgers = scopes.map(({ scope, dir }) => ({ scope, ...verifyLedger(root, dir) }));
  const errors = ledgers.flatMap((l) => l.errors.map((e) => `${l.scope}: ${e}`));
  return { ok: errors.length === 0, errors, count: ledgers.reduce((n, l) => n + l.count, 0), ledgers };
}

// ---------------------------------------------------------------- features

export const featuresDir = (root) => path.join(root, TNT_DIR, 'features');
export const reviewsDir = (root) => path.join(root, TNT_DIR, 'reviews');

function listScopes(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => pattern.test(d) && fs.existsSync(statePath(path.join(dir, d))))
    .map((d) => ({ id: d.match(pattern)[1], dirName: d, dir: path.join(dir, d), state: loadState(path.join(dir, d)) }))
    .sort((a, b) => (a.state.created ?? '').localeCompare(b.state.created ?? '') || a.dirName.localeCompare(b.dirName));
}
export const listFeatures = (root) => listScopes(featuresDir(root), FEATURE_DIR);
export const listReviews = (root) => listScopes(reviewsDir(root), REVIEW_DIR);

// Resolves a feature (F-…) or a review of a non-tnt change (R-…).
export function resolveFeature(root, ref) {
  if (!ref) throw new TntError('feature id required (e.g. F-7KQ2MX, or R-… for a review)');
  const want = ref.toUpperCase();
  const review = want.startsWith('R-');
  const match = (review ? listReviews(root) : listFeatures(root)).find((f) => f.id === want || f.dirName.toUpperCase() === want);
  if (!match) throw new TntError(`unknown ${review ? 'review' : 'feature'} ${ref}`);
  return match;
}

export const statePath = (featureDir) => path.join(featureDir, 'state.json');
export const loadState = (featureDir) => readJson(statePath(featureDir));
export const saveState = (featureDir, state) => writeJson(statePath(featureDir), state);
export const specPath = (featureDir) => path.join(featureDir, 'spec.md');
export const evidenceDir = (root, featureDir) => path.join(scopeDir(root, featureDir), 'evidence');

// active.json says which feature *this checkout* is working on, view.html is
// generated by `tnt view`, and reviews/ holds reviews of other people's changes.
// All are local and never committed: .tnt/.gitignore excludes them.
export const activePath = (root) => path.join(root, TNT_DIR, 'active.json');
export function ensureLocalIgnores(root) {
  const p = path.join(root, TNT_DIR, '.gitignore');
  let have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const missing = ['active.json', 'view.html', 'reviews/'].filter((name) => !new RegExp(`^/?${name.replace('.', '\\.')}$`, 'm').test(have));
  if (!missing.length) return;
  if (have && !have.endsWith('\n')) have += '\n';
  if (!have.includes('# local to each checkout')) have += '# local to each checkout\n';
  fs.writeFileSync(p, have + missing.join('\n') + '\n');
}
export function readActive(root) {
  const p = activePath(root);
  return fs.existsSync(p) ? readJson(p) : null;
}

export const SPEC_TEMPLATE = (id, title) => `# ${id}: ${title}

## Context
<!-- Why this feature exists, who it is for, links to project.md decisions. -->

## Acceptance criteria
<!-- One line each: "- AC-<n>: Given <context>, when <action>, then <observable outcome>." -->
- AC-1: Given ..., when ..., then ...

## Out of scope

## Functional verification plan
<!-- Per AC: how a tester observes it in the running system (command, request, UI steps),
     then "Expect: \`<regex>\`" for the exact output that proves it, e.g. Expect: \`total: 42\.00\`.
     The functional gate requires a recorded run whose output matches every Expect. -->
- AC-1: ... Expect: \`...\`

## Notes
`;

export const REVIEW_SPEC_TEMPLATE = (id, title, target) => `# ${id}: ${title}

Review of ${target.ref} (${target.commit}) against ${target.baseRef}. This change was not built with tnt.

## Context
<!-- What the change says it does, its author and its link (PR description, ticket). -->

## Acceptance criteria
<!-- The change's claims, one observable behaviour each, written so they can be checked:
     "- AC-<n>: Given <context>, when <action>, then <observable outcome>." -->
- AC-1: Given ..., when ..., then ...

## Out of scope
<!-- What the change does not claim to do. -->

## Functional verification plan
<!-- Per AC: how to observe it in the running system, then "Expect: \`<regex>\`". -->
- AC-1: ... Expect: \`...\`

## Notes
`;

export function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature';
}

export function parseAcceptanceCriteria(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+acceptance criteria\s*$/i.test(l.trim()));
  if (start < 0) throw new TntError('spec.md has no "## Acceptance criteria" section');
  const acs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const m = line.match(/^\s*[-*]\s+\**(AC-\d+)\**\s*[:.)–-]\s*(.+)$/);
    if (m) {
      if (acs.some((a) => a.id === m[1])) throw new TntError(`duplicate acceptance criterion ${m[1]}`);
      acs.push({ id: m[1], text: m[2].trim() });
    }
  }
  return acs;
}

// Expected outcomes per AC from the "Functional verification plan" section:
// `- AC-1: <how to observe it>. Expect: \`<regex>\`` (several per AC allowed, also
// on continuation lines). They are part of the approved spec, so the human signs
// off on what counts as proof, not the functional tester.
export function parseSpecExpectations(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+functional verification plan\s*$/i.test(l.trim()));
  const out = new Map();
  if (start < 0) return out;
  let ac = null;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const m = line.match(/^\s*[-*]\s+\**(AC-\d+)\**/);
    if (m) ac = m[1];
    if (!ac) continue;
    for (const [, pattern] of line.matchAll(/\bexpect(?:ed)?\s*:\s*`([^`]+)`/gi)) {
      if (!out.has(ac)) out.set(ac, []);
      out.get(ac).push(pattern);
    }
  }
  return out;
}

// Output that any command could print. A spec expectation matching one of these
// would pass without proving the AC.
const GENERIC_OUTPUT = ['', 'ok', 'OK', 'true', 'success', 'Success', 'done', 'passed', 'PASS', '200', '0', '1', 'null', 'undefined', 'error'];
export function weakExpectation(pattern) {
  let re;
  try { re = new RegExp(pattern, 'm'); } catch (e) { return `is not a valid regex: ${e.message}`; }
  const hit = GENERIC_OUTPUT.find((s) => re.test(s));
  return hit === undefined ? null : `also matches generic output ${JSON.stringify(hit)}; name the specific value that proves the AC`;
}

// Finds an acceptance-criterion id in any naming style a test framework allows,
// since many languages can't put "-" in a test name: "AC-1", "AC 1", "AC1",
// "test_ac_1_x" (pytest), "TestAC1X" (Go), "ac1_x" (Rust), "givenAc1X" (camelCase).
// It must not follow an uppercase letter or digit, so "MAC1" and "HVAC1" miss, and it
// must not be followed by a digit, so "AC-1" never matches "AC-10".
export function acRegex(id) {
  const n = /^AC-(\d+)$/i.exec(id)?.[1];
  if (!n) return new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`);
  return new RegExp(`(?<![A-Z0-9])[Aa][Cc][-_ ]?${n}(?!\\d)`);
}

export function fileSha(root, rel) {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null;
}

export function relPath(root, p) {
  return toPosix(path.relative(root, path.resolve(root, p)));
}
