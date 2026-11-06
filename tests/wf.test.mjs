import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  wf, git, write, read, makeProject, driveTo, SPEC, TEST_FILE, APP, FUNCTIONAL_CMD,
} from './helpers.mjs';

test('happy path reaches done with commits, report and an intact ledger', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'audit');
  const st = JSON.parse(wf(dir, 'status', 'F-001', '--json').stdout);
  assert.equal(st.phase, 'done');
  const log = git(dir, 'log', '--format=%s').stdout;
  assert.match(log, /\[wf:red\]/);
  assert.match(log, /\[wf:green\]/);
  assert.match(log, /\[wf:done\]/);
  // red commit precedes green commit: tests existed before the implementation
  assert.ok(log.indexOf('[wf:green]') < log.indexOf('[wf:red]'));
  assert.equal(wf(dir, 'ledger', 'verify').code, 0);
  assert.match(read(dir, path.join(fd, 'report.md')), /Ledger integrity: \*\*intact\*\*/);
  assert.equal(fs.existsSync(path.join(dir, '.agentic-wf', 'active.json')), false);
});

test('approve rejects a spec that still has template placeholders', () => {
  const dir = makeProject();
  wf(dir, 'new', 'Add numbers');
  const r = wf(dir, 'approve', 'F-001', '--by', 'Tester');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /placeholders/);
});

test('red gate fails when the new tests already pass', () => {
  const dir = makeProject();
  driveTo(dir, 'spec');
  wf(dir, 'start', 'F-001');
  write(dir, 'app.mjs', APP);
  write(dir, 'app.test.mjs', TEST_FILE);
  wf(dir, 'lock-tests', 'F-001', 'app.test.mjs');
  wf(dir, 'run', 'F-001', 'red');
  const g = wf(dir, 'gate', 'F-001', 'red');
  assert.equal(g.code, 1);
  assert.match(g.out, /passed \(exit 0\)/);
});

test('red gate requires every AC to be referenced by a locked test', () => {
  const dir = makeProject();
  driveTo(dir, 'spec');
  wf(dir, 'start', 'F-001');
  write(dir, 'app.test.mjs', TEST_FILE.replace('AC-1: ', ''));
  wf(dir, 'lock-tests', 'F-001', 'app.test.mjs');
  wf(dir, 'run', 'F-001', 'red');
  const g = wf(dir, 'gate', 'F-001', 'red');
  assert.equal(g.code, 1);
  assert.match(g.out, /AC-1 is not referenced/);
});

test('red and green refuse a caller-supplied command', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const r = wf(dir, 'run', 'F-001', 'green', '--', 'node', '-e', 'process.exit(0)');
  assert.equal(r.code, 2);
});

test('green gate fails when a locked test is modified', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  write(dir, 'app.mjs', APP);
  write(dir, 'app.test.mjs', TEST_FILE.replace('assert.equal(add(2, 3), 5);', 'assert.ok(true);'));
  wf(dir, 'run', 'F-001', 'green');
  const g = wf(dir, 'gate', 'F-001', 'green');
  assert.equal(g.code, 1);
  assert.match(g.out, /modified after locking/);
});

test('changing code after green invalidates later gates', () => {
  const dir = makeProject();
  driveTo(dir, 'style');
  write(dir, 'app.mjs', APP + '// tweak\n');
  const g = wf(dir, 'gate', 'F-001', 'review');
  assert.equal(g.code, 1);
  assert.match(g.out, /code changed since the green gate/);
});

test('re-passing green clears style and later gates', () => {
  const dir = makeProject();
  driveTo(dir, 'style');
  write(dir, 'app.mjs', APP + '// tweak\n');
  wf(dir, 'run', 'F-001', 'green');
  assert.equal(wf(dir, 'gate', 'F-001', 'green').code, 0);
  const st = JSON.parse(wf(dir, 'status', 'F-001', '--json').stdout);
  assert.equal(st.phase, 'green');
  assert.equal(st.gates.style, undefined);
});

test('review submission rejects fabricated quotes and unreviewed files', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'style');
  write(dir, path.join(fd, 'review.draft.json'), JSON.stringify({
    verdict: 'changes_requested', files_reviewed: ['app.mjs'],
    findings: [{ severity: 'major', file: 'app.mjs', line: 1, quote: 'eval(userInput)', issue: 'injection' }],
  }));
  const r = wf(dir, 'review', 'submit', 'F-001', path.join(fd, 'review.draft.json'));
  assert.equal(r.code, 2);
  assert.match(r.out, /not reviewed: app\.test\.mjs/);
  assert.match(r.out, /quote not found/);
});

test('review cannot approve with a major finding', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'style');
  write(dir, path.join(fd, 'review.draft.json'), JSON.stringify({
    verdict: 'approve', files_reviewed: ['app.mjs', 'app.test.mjs'],
    findings: [{ severity: 'major', file: 'app.mjs', line: 1, quote: '(a, b) => a + b', issue: 'no input validation' }],
  }));
  const r = wf(dir, 'review', 'submit', 'F-001', path.join(fd, 'review.draft.json'));
  assert.equal(r.code, 2);
  assert.match(r.out, /cannot approve/);
});

test('functional gate needs an asserted expectation per AC', () => {
  const dir = makeProject();
  driveTo(dir, 'review');
  wf(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'sum=6', '--', FUNCTIONAL_CMD);
  const g = wf(dir, 'gate', 'F-001', 'functional');
  assert.equal(g.code, 1);
  assert.match(g.out, /no matching --expect/);
});

test('a run that mutates the tree is not accepted as evidence', () => {
  const dir = makeProject();
  const cfgPath = path.join(dir, '.agentic-wf', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.commands.lint = `node -e "require('fs').appendFileSync('app.mjs', '// fixed\\n')"`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  driveTo(dir, 'green');
  wf(dir, 'run', 'F-001', 'style');
  const g = wf(dir, 'gate', 'F-001', 'style');
  assert.equal(g.code, 1);
  assert.match(g.out, /code changed since the green gate|modified the working tree/);
});

test('editing a ledger entry or an evidence log is detected', () => {
  const dir = makeProject();
  driveTo(dir, 'green');
  const ledgerFile = path.join(dir, '.agentic-wf', 'ledger.jsonl');
  const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
  const idx = lines.findIndex((l) => l.includes('"step":"red"'));
  lines[idx] = lines[idx].replace('"exit":1', '"exit":0');
  fs.writeFileSync(ledgerFile, lines.join('\n') + '\n');
  const r = wf(dir, 'ledger', 'verify');
  assert.equal(r.code, 1);
  assert.match(r.out, /content hash mismatch/);

  const dir2 = makeProject();
  const fd2 = driveTo(dir2, 'green');
  const logs = fs.readdirSync(path.join(dir2, fd2, 'evidence')).filter((f) => f.endsWith('.log'));
  fs.appendFileSync(path.join(dir2, fd2, 'evidence', logs[0]), 'forged\n');
  const r2 = wf(dir2, 'ledger', 'verify');
  assert.equal(r2.code, 1);
  assert.match(r2.out, /evidence file altered/);
});

test('unlock resets to spec so a new failing test can be added', () => {
  const dir = makeProject();
  driveTo(dir, 'green');
  assert.equal(wf(dir, 'unlock', 'F-001', '--reason', 'functional defect: negative numbers').code, 0);
  write(dir, 'app.test.mjs', TEST_FILE + `test('AC-1: handles strings as numbers', async () => {
  const { add } = await import('./app.mjs');
  assert.equal(add('2', '3'), 5);
});
`);
  wf(dir, 'lock-tests', 'F-001', 'app.test.mjs');
  wf(dir, 'run', 'F-001', 'red');
  assert.equal(wf(dir, 'gate', 'F-001', 'red').code, 0);
});

test('start refuses a dirty working tree', () => {
  const dir = makeProject();
  driveTo(dir, 'spec');
  write(dir, 'stray.txt', 'x');
  const r = wf(dir, 'start', 'F-001');
  assert.equal(r.code, 2);
  assert.match(r.out, /uncommitted changes/);
});

test('spec edits after approval block progress', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'red');
  write(dir, path.join(fd, 'spec.md'), SPEC.replace('their sum', 'their sum, rounded'));
  write(dir, 'app.mjs', APP);
  wf(dir, 'run', 'F-001', 'green');
  const g = wf(dir, 'gate', 'F-001', 'green');
  assert.equal(g.code, 1);
  assert.match(g.out, /re-approve/);
});

test('check evaluates a gate without recording, committing or counting attempts', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const ledgerBefore = read(dir, '.agentic-wf/ledger.jsonl');
  const headBefore = git(dir, 'rev-parse', 'HEAD').stdout;
  const fail = wf(dir, 'check', 'F-001', 'green');
  assert.equal(fail.code, 1);
  assert.match(fail.out, /check green for F-001: FAIL/);
  write(dir, 'app.mjs', APP);
  wf(dir, 'run', 'F-001', 'green');
  const ledgerAfterRun = read(dir, '.agentic-wf/ledger.jsonl');
  const pass = wf(dir, 'check', 'F-001', 'green');
  assert.equal(pass.code, 0);
  assert.match(pass.out, /check green for F-001: PASS/);
  assert.equal(read(dir, '.agentic-wf/ledger.jsonl'), ledgerAfterRun);
  assert.notEqual(ledgerAfterRun, ledgerBefore);
  assert.equal(git(dir, 'rev-parse', 'HEAD').stdout, headBefore);
  const st = JSON.parse(wf(dir, 'status', 'F-001', '--json').stdout);
  assert.equal(st.phase, 'red');
  assert.equal(st.attempts.green ?? 0, 0);
});

test('extra functional runs add to the spec evidence instead of replacing it', () => {
  const dir = makeProject();
  driveTo(dir, 'review');
  wf(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'sum=5', '--', FUNCTIONAL_CMD);
  const extra = `node -e "import('./app.mjs').then(m => console.log('sum=' + m.add(-1, 1)))"`;
  wf(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'sum=0', '--', extra);
  assert.equal(wf(dir, 'gate', 'F-001', 'functional').code, 0);
  const v = JSON.parse(wf(dir, 'verify', 'F-001', '--json').stdout);
  assert.equal(v.ok, true);
  const ledger = read(dir, '.agentic-wf/ledger.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  const reruns = ledger.filter((e) => v.reruns.includes(e.seq) && e.name === 'functional');
  assert.deepEqual(reruns.map((e) => e.expect).sort(), ['sum=0', 'sum=5']);
});

test('a failing functional run blocks only until it is re-recorded passing', () => {
  const dir = makeProject();
  driveTo(dir, 'review');
  wf(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'sum=6', '--', FUNCTIONAL_CMD);
  wf(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'sum=5', '--', FUNCTIONAL_CMD);
  assert.equal(wf(dir, 'gate', 'F-001', 'functional').code, 0);
});

test('verify re-executes functional evidence and fails if behaviour regressed', () => {
  const dir = makeProject();
  driveTo(dir, 'functional');
  write(dir, 'app.mjs', 'export const add = (a, b) => a - b;\n');
  const r = wf(dir, 'verify', 'F-001');
  assert.equal(r.code, 1);
  assert.match(r.out, /differs from the green-gated tree/);
  assert.match(r.out, /expected output no longer observed/);
});
