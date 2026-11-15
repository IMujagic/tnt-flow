import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN = path.resolve(here, '..', 'plugins', 'think-and-type');
export const TNT = path.join(PLUGIN, 'scripts', 'tnt.mjs');
export const GUARD = path.join(PLUGIN, 'scripts', 'hooks', 'guard.mjs');

// The outer `node --test` sets NODE_TEST_CONTEXT, which would make the demo
// project's own `node --test` report to us instead of running normally.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

export function sh(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, env: ENV });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
}

export const tnt = (cwd, ...args) => sh(process.execPath, [TNT, ...args], cwd);
export const git = (cwd, ...args) => sh('git', args, cwd);

export const write = (dir, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
export const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

// A tiny project whose test suite is `node --test`, plus a no-op linter.
export function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnt-test-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'tnt test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'README.md', '# demo\n');
  write(dir, '.gitignore', 'node_modules/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  const init = tnt(dir, 'init');
  if (init.code !== 0) throw new Error(init.out);
  const cfgPath = path.join(dir, '.tnt', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.commands.test = 'node --test';
  cfg.commands.lint = 'node -e "process.exit(0)"';
  cfg.style = ['lint'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'tnt init');
  return dir;
}

export const SPEC = `# F-001: Add numbers

## Context
Callers need to add two numbers.

## Acceptance criteria
- AC-1: Given two numbers, when add is called, then it returns their sum.

## Out of scope

## Functional verification plan
- AC-1: run add(2, 3) and print the sum. Expect: \`sum=5\`
`;

export const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('AC-1: add returns the sum', async () => {
  const { add } = await import('./app.mjs');
  assert.equal(add(2, 3), 5);
});
`;

export const APP = 'export const add = (a, b) => a + b;\n';
export const FUNCTIONAL_CMD = `node -e "import('./app.mjs').then(m => console.log('sum=' + m.add(2, 3)))"`;

export function featureDir(dir, id = 'F-001') {
  const fdir = fs.readdirSync(path.join(dir, '.tnt', 'features')).find((d) => d.startsWith(id + '-'));
  return path.join('.tnt', 'features', fdir);
}

export const ledgerOf = (dir, fd) => read(dir, path.join(fd, 'ledger.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
export const branch = (dir) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();

// Drive a feature up to (and including) the named gate. `module` names the
// source file (app.mjs) and its test (app.test.mjs), so several features can
// live in one repo.
export function driveTo(dir, last, { id = 'F-001', module = 'app' } = {}) {
  const order = ['spec', 'red', 'green', 'style', 'review', 'functional', 'audit'];
  const upto = order.indexOf(last);
  const must = (r) => { if (r.code !== 0) throw new Error(r.out); return r; };
  const src = `${module}.mjs`;
  const testFile = `${module}.test.mjs`;
  const fix = (x) => x.replaceAll('./app.mjs', `./${src}`);
  must(tnt(dir, 'new', 'Add numbers', '--id', id));
  const fd = featureDir(dir, id);
  write(dir, path.join(fd, 'spec.md'), SPEC);
  must(tnt(dir, 'approve', id, '--by', 'Tester'));
  if (upto < 1) return fd;
  must(tnt(dir, 'start', id));
  write(dir, testFile, fix(TEST_FILE));
  must(tnt(dir, 'lock-tests', id, testFile));
  must(tnt(dir, 'run', id, 'red'));
  must(tnt(dir, 'gate', id, 'red'));
  if (upto < 2) return fd;
  write(dir, src, APP);
  must(tnt(dir, 'run', id, 'green'));
  must(tnt(dir, 'gate', id, 'green'));
  if (upto < 3) return fd;
  must(tnt(dir, 'run', id, 'style'));
  must(tnt(dir, 'gate', id, 'style'));
  if (upto < 4) return fd;
  write(dir, path.join(fd, 'review.draft.json'), JSON.stringify({
    verdict: 'approve', summary: 'ok', files_reviewed: [src, testFile],
    findings: [{ id: 'R1', severity: 'nit', file: src, line: 1, quote: 'export const add', issue: 'consider JSDoc' }],
  }));
  must(tnt(dir, 'review', 'submit', id, path.join(fd, 'review.draft.json')));
  must(tnt(dir, 'gate', id, 'review'));
  if (upto < 5) return fd;
  must(tnt(dir, 'run', id, 'functional', '--ac', 'AC-1', '--expect', 'sum=5', '--', fix(FUNCTIONAL_CMD)));
  must(tnt(dir, 'gate', id, 'functional'));
  if (upto < 6) return fd;
  must(tnt(dir, 'verify', id));
  write(dir, path.join(fd, 'audit.draft.json'), JSON.stringify({
    verdict: 'pass', checks: [{ name: 'tests assert AC-1 behaviour', result: 'pass', evidence: `${testFile}:5` }],
  }));
  must(tnt(dir, 'audit', 'submit', id, path.join(fd, 'audit.draft.json')));
  must(tnt(dir, 'gate', id, 'audit'));
  return fd;
}
