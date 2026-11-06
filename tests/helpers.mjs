import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN = path.resolve(here, '..', 'plugins', 'agentic-wf');
export const WF = path.join(PLUGIN, 'scripts', 'wf.mjs');
export const GUARD = path.join(PLUGIN, 'scripts', 'hooks', 'guard.mjs');

// The outer `node --test` sets NODE_TEST_CONTEXT, which would make the demo
// project's own `node --test` report to us instead of running normally.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

export function sh(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, env: ENV });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
}

export const wf = (cwd, ...args) => sh(process.execPath, [WF, ...args], cwd);
export const git = (cwd, ...args) => sh('git', args, cwd);

export const write = (dir, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
export const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

// A tiny project whose test suite is `node --test`, plus a no-op linter.
export function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'wf test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'README.md', '# demo\n');
  write(dir, '.gitignore', 'node_modules/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  const init = wf(dir, 'init');
  if (init.code !== 0) throw new Error(init.out);
  const cfgPath = path.join(dir, '.agentic-wf', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.commands.test = 'node --test';
  cfg.commands.lint = 'node -e "process.exit(0)"';
  cfg.style = ['lint'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'wf init');
  return dir;
}

export const SPEC = `# F-001: Add numbers

## Context
Callers need to add two numbers.

## Acceptance criteria
- AC-1: Given two numbers, when add is called, then it returns their sum.

## Out of scope

## Functional verification plan
- AC-1: run add(2, 3) and observe sum=5
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

export function featureDir(dir) {
  const fdir = fs.readdirSync(path.join(dir, '.agentic-wf', 'features')).find((d) => d.startsWith('F-001'));
  return path.join('.agentic-wf', 'features', fdir);
}

// Drive a feature up to (and including) the named gate.
export function driveTo(dir, last) {
  const order = ['spec', 'red', 'green', 'style', 'review', 'functional', 'audit'];
  const upto = order.indexOf(last);
  const must = (r) => { if (r.code !== 0) throw new Error(r.out); return r; };
  must(wf(dir, 'new', 'Add numbers'));
  const fd = featureDir(dir);
  write(dir, path.join(fd, 'spec.md'), SPEC);
  must(wf(dir, 'approve', 'F-001', '--by', 'Tester'));
  if (upto < 1) return fd;
  must(wf(dir, 'start', 'F-001'));
  write(dir, 'app.test.mjs', TEST_FILE);
  must(wf(dir, 'lock-tests', 'F-001', 'app.test.mjs'));
  must(wf(dir, 'run', 'F-001', 'red'));
  must(wf(dir, 'gate', 'F-001', 'red'));
  if (upto < 2) return fd;
  write(dir, 'app.mjs', APP);
  must(wf(dir, 'run', 'F-001', 'green'));
  must(wf(dir, 'gate', 'F-001', 'green'));
  if (upto < 3) return fd;
  must(wf(dir, 'run', 'F-001', 'style'));
  must(wf(dir, 'gate', 'F-001', 'style'));
  if (upto < 4) return fd;
  write(dir, path.join(fd, 'review.draft.json'), JSON.stringify({
    verdict: 'approve', summary: 'ok', files_reviewed: ['app.mjs', 'app.test.mjs'],
    findings: [{ id: 'R1', severity: 'nit', file: 'app.mjs', line: 1, quote: 'export const add', issue: 'consider JSDoc' }],
  }));
  must(wf(dir, 'review', 'submit', 'F-001', path.join(fd, 'review.draft.json')));
  must(wf(dir, 'gate', 'F-001', 'review'));
  if (upto < 5) return fd;
  must(wf(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'sum=5', '--', FUNCTIONAL_CMD));
  must(wf(dir, 'gate', 'F-001', 'functional'));
  if (upto < 6) return fd;
  must(wf(dir, 'verify', 'F-001'));
  write(dir, path.join(fd, 'audit.draft.json'), JSON.stringify({
    verdict: 'pass', checks: [{ name: 'tests assert AC-1 behaviour', result: 'pass', evidence: 'app.test.mjs:5' }],
  }));
  must(wf(dir, 'audit', 'submit', 'F-001', path.join(fd, 'audit.draft.json')));
  must(wf(dir, 'gate', 'F-001', 'audit'));
  return fd;
}
