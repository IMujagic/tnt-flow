// Core primitives for the agentic-wf harness: git tree hashing, the
// hash-chained evidence ledger, config, feature state and spec parsing.
// Zero dependencies; Node >= 18.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const WF_DIR = '.agentic-wf';
export const GATES = ['spec', 'red', 'green', 'style', 'review', 'functional', 'audit'];
export const PROJECT_FEATURE = '_project';

export class WfError extends Error {}

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
  if (r.error) throw new WfError(`git is not available: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new WfError(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
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
// .gitignore, excluding .agentic-wf/). Independent of commits, so evidence
// stays bound to the exact code it was produced against.
export function treeHash(root) {
  const tmp = path.join(os.tmpdir(), `wf-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const realIndex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).stdout.trim());
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmp);
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    git(root, ['add', '-A', '--', '.', `:(exclude)${WF_DIR}`], { env });
    git(root, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', WF_DIR], { env });
    return git(root, ['write-tree'], { env }).stdout.trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function isClean(root) {
  const r = git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${WF_DIR}`]);
  return r.stdout.trim() === '';
}

export function changedFiles(root, base, tree) {
  // Added/modified/renamed files only (deletions cannot be quoted), never harness files.
  const out = base
    ? git(root, ['diff', '--name-only', '--diff-filter=ACMRT', base, tree]).stdout
    : git(root, ['ls-tree', '-r', '--name-only', tree]).stdout;
  return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith(WF_DIR + '/'));
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
    if (fs.existsSync(path.join(dir, WF_DIR, 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireRoot(start) {
  const root = findRoot(start);
  if (!root) throw new WfError(`No ${WF_DIR}/config.json found. Run \`wf init\` in the project root first.`);
  return root;
}

export const DEFAULT_CONFIG = {
  version: 1,
  project: { name: '', type: 'existing' },
  commands: { test: null, lint: null, format_check: null, typecheck: null, build: null },
  style: [],
  git: { autoCommit: true, branchPerFeature: true, branchPrefix: 'wf/' },
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

export const configPath = (root) => path.join(root, WF_DIR, 'config.json');
export function loadConfig(root) {
  return deepMerge(DEFAULT_CONFIG, readJson(configPath(root)));
}

// ---------------------------------------------------------------- ledger

export const ledgerPath = (root) => path.join(root, WF_DIR, 'ledger.jsonl');

export function readLedger(root) {
  const p = ledgerPath(root);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new WfError(`ledger line ${i + 1} is not valid JSON`); }
  });
}

export function nextSeq(root) {
  const l = readLedger(root);
  return l.length ? l[l.length - 1].seq + 1 : 1;
}

export function appendLedger(root, entry) {
  const ledger = readLedger(root);
  const last = ledger[ledger.length - 1];
  const body = { ...entry, seq: last ? last.seq + 1 : 1, ts: new Date().toISOString(), prev: last ? last.hash : 'GENESIS' };
  const full = { ...body, hash: sha256(stableStringify(body)) };
  fs.appendFileSync(ledgerPath(root), JSON.stringify(full) + '\n');
  return full;
}

export function verifyLedger(root) {
  const errors = [];
  let prev = 'GENESIS';
  let ledger;
  try { ledger = readLedger(root); } catch (e) { return { ok: false, errors: [e.message] }; }
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

// ---------------------------------------------------------------- features

export const featuresDir = (root) => path.join(root, WF_DIR, 'features');

export function listFeatures(root) {
  const dir = featuresDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => /^F-\d{3,}/.test(d)).sort().map((d) => ({
    id: d.match(/^F-\d+/)[0], dirName: d, dir: path.join(dir, d), state: loadState(path.join(dir, d)),
  }));
}

export function resolveFeature(root, ref) {
  if (!ref) throw new WfError('feature id required (e.g. F-001)');
  const want = ref.toUpperCase();
  const match = listFeatures(root).find((f) => f.id === want || f.dirName.toUpperCase() === want);
  if (!match) throw new WfError(`unknown feature ${ref}`);
  return match;
}

export const statePath = (featureDir) => path.join(featureDir, 'state.json');
export const loadState = (featureDir) => readJson(statePath(featureDir));
export const saveState = (featureDir, state) => writeJson(statePath(featureDir), state);
export const specPath = (featureDir) => path.join(featureDir, 'spec.md');
export const evidenceDir = (root, featureDir) =>
  featureDir ? path.join(featureDir, 'evidence') : path.join(root, WF_DIR, 'evidence');

export const activePath = (root) => path.join(root, WF_DIR, 'active.json');
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
<!-- Per AC: how a tester observes it in the running system (command, request, UI steps)
     and the exact observable output that proves it. -->
- AC-1: ...

## Notes
`;

export function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature';
}

export function parseAcceptanceCriteria(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+acceptance criteria\s*$/i.test(l.trim()));
  if (start < 0) throw new WfError('spec.md has no "## Acceptance criteria" section');
  const acs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const m = line.match(/^\s*[-*]\s+\**(AC-\d+)\**\s*[:.)–-]\s*(.+)$/);
    if (m) {
      if (acs.some((a) => a.id === m[1])) throw new WfError(`duplicate acceptance criterion ${m[1]}`);
      acs.push({ id: m[1], text: m[2].trim() });
    }
  }
  return acs;
}

export const acRegex = (id) => new RegExp(`${id}(?!\\d)`);

export function fileSha(root, rel) {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null;
}

export function relPath(root, p) {
  return toPosix(path.relative(root, path.resolve(root, p)));
}
