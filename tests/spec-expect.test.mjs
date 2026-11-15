import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tnt, write, read, makeProject, driveTo, featureDir, SPEC } from './helpers.mjs';

const newSpec = (dir, spec) => {
  tnt(dir, 'new', 'Add numbers', '--id', 'F-001');
  write(dir, path.join(featureDir(dir), 'spec.md'), spec);
  return tnt(dir, 'approve', 'F-001', '--by', 'Tester');
};

test('approve requires an expected outcome for every AC', () => {
  const dir = makeProject();
  const r = newSpec(dir, SPEC.replace(' Expect: `sum=5`', ''));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /AC-1 has no expected outcome/);
});

test('approve rejects expectations that match generic output or are not regexes', () => {
  for (const [pattern, why] of [['ok', /generic output "ok"/], ['.*', /generic output ""/], ['(sum', /not a valid regex/], ['...', /generic output/]]) {
    const dir = makeProject();
    const r = newSpec(dir, SPEC.replace('`sum=5`', '`' + pattern + '`'));
    assert.notEqual(r.code, 0, pattern);
    assert.match(r.out, why, pattern);
  }
});

test('approve rejects an Expect for an AC that does not exist', () => {
  const dir = makeProject();
  const r = newSpec(dir, SPEC + '- AC-9: something else. Expect: `nine=9`\n');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Expect for AC-9, which is not an acceptance criterion/);
});

test('requireSpecExpect false allows specs without expectations', () => {
  const dir = makeProject();
  const cfgPath = path.join(dir, '.tnt', 'config.json');
  const cfg = JSON.parse(read(dir, '.tnt/config.json'));
  cfg.functional = { requireSpecExpect: false };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.equal(newSpec(dir, SPEC.replace(' Expect: `sum=5`', '')).code, 0);
});

test('functional gate needs a run that prints the spec expectation, not just the tester --expect', () => {
  const dir = makeProject();
  driveTo(dir, 'review');
  const weak = tnt(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'loaded', '--', `node -e "import('./app.mjs').then(() => console.log('loaded'))"`);
  assert.equal(weak.code, 0, weak.out);
  const g = tnt(dir, 'gate', 'F-001', 'functional');
  assert.equal(g.code, 1);
  assert.match(g.out, /AC-1: no functional run on the current tree printed the spec's expected outcome \/sum=5\//);
  const fd = featureDir(dir);
  const entry = read(dir, path.join(fd, 'ledger.jsonl')).trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.type === 'run');
  assert.deepEqual(entry.specExpect, [{ pattern: 'sum=5', matched: false }]);
  tnt(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'sum=\\d', '--', `node -e "import('./app.mjs').then(m => console.log('sum=' + m.add(2, 3)))"`);
  assert.equal(tnt(dir, 'gate', 'F-001', 'functional').code, 0);
});

test('verify fails when re-runs no longer print the spec expectation', () => {
  const dir = makeProject();
  driveTo(dir, 'review');
  write(dir, 'node_modules/out.txt', 'sum=5\n'); // git-ignored, so the tree stays the same
  tnt(dir, 'run', 'F-001', 'functional', '--ac', 'AC-1', '--expect', 'sum=\\d', '--', 'cat node_modules/out.txt');
  assert.equal(tnt(dir, 'gate', 'F-001', 'functional').code, 0);
  write(dir, 'node_modules/out.txt', 'sum=6\n');
  const v = tnt(dir, 'verify', 'F-001');
  assert.equal(v.code, 1);
  assert.match(v.out, /AC-1: re-runs no longer print the spec's expected outcome \/sum=5\//);
  const i = tnt(dir, 'verify', '--integrated', 'F-001');
  assert.equal(i.code, 1);
  assert.match(i.out, /F-001 AC-1: the spec's expected outcome \/sum=5\/ is no longer printed/);
});
