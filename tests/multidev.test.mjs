// Several developers on one repo: per-feature ledgers, collision-free ids,
// local-only active state, syncing a feature onto a moved base branch, and
// re-verifying the integrated (merged) tree without recording anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tnt, git, write, makeProject, driveTo, ledgerOf, branch, TEST_FILE } from './helpers.mjs';

const ledgerFiles = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'ledger.jsonl') out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(path.join(dir, '.tnt'));
  return out;
};

test('each feature has its own hash chain and project events have theirs', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'green');
  assert.equal(fs.existsSync(path.join(dir, '.tnt', 'ledger.jsonl')), false);
  assert.ok(fs.existsSync(path.join(dir, '.tnt', '_project', 'ledger.jsonl')));
  const entries = ledgerOf(dir, fd);
  assert.equal(entries[0].seq, 1);
  assert.equal(entries[0].prev, 'GENESIS');
  assert.equal(entries[0].type, 'feature-created');
  assert.ok(entries.every((e) => e.feature === 'F-001'));
  assert.equal(tnt(dir, 'ledger', 'verify').code, 0);
});

test('two developers finish features on separate branches and both merge without conflicts', () => {
  const dir = makeProject();
  const main = branch(dir);
  driveTo(dir, 'audit', { id: 'F-A1', module: 'alpha' });
  const a = branch(dir);
  git(dir, 'checkout', '-q', main);
  driveTo(dir, 'audit', { id: 'F-B2', module: 'beta' });
  const b = branch(dir);
  git(dir, 'checkout', '-q', main);

  const m1 = git(dir, 'merge', '--no-edit', a);
  assert.equal(m1.code, 0, m1.out);
  const m2 = git(dir, 'merge', '--no-edit', b);
  assert.equal(m2.code, 0, m2.out);

  const lv = tnt(dir, 'ledger', 'verify');
  assert.equal(lv.code, 0, lv.out);
  const v = tnt(dir, 'verify', '--integrated');
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /F-A1/);
  assert.match(v.out, /F-B2/);
  assert.equal(git(dir, 'status', '--porcelain').stdout, '');
});

test('new feature ids are random unless --id is given, and never collide', () => {
  const dir = makeProject();
  const a = JSON.parse(tnt(dir, 'new', 'One', '--json').stdout).id;
  const b = JSON.parse(tnt(dir, 'new', 'Two', '--json').stdout).id;
  assert.match(a, /^F-[0-9A-Z]{6}$/);
  assert.match(b, /^F-[0-9A-Z]{6}$/);
  assert.notEqual(a, b);
  assert.equal(tnt(dir, 'new', 'Three', '--id', 'f-042').code, 0);
  const dup = tnt(dir, 'new', 'Again', '--id', 'F-042');
  assert.equal(dup.code, 2);
  assert.match(dup.out, /already exists/);
  const bad = tnt(dir, 'new', 'Bad', '--id', 'F-4-2');
  assert.equal(bad.code, 2);
  const st = JSON.parse(tnt(dir, 'status', '--json').stdout);
  assert.deepEqual(st.features.map((f) => f.id), [a, b, 'F-042']);
});

test('the active feature is local to each checkout and never committed', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  assert.ok(fs.existsSync(path.join(dir, '.tnt', 'active.json')));
  assert.equal(git(dir, 'check-ignore', '-q', '.tnt/active.json').code, 0);
  assert.equal(git(dir, 'ls-files', '.tnt/active.json').stdout.trim(), '');
});

test('a project with the old single ledger is refused with guidance', () => {
  const dir = makeProject();
  write(dir, '.tnt/ledger.jsonl', '');
  const r = tnt(dir, 'status');
  assert.equal(r.code, 2);
  assert.match(r.out, /single shared ledger/);
});

test('integrated verify re-runs done features on the current tree and records nothing', () => {
  const dir = makeProject();
  driveTo(dir, 'audit');
  write(dir, 'app.mjs', 'export const add = (a, b) => a - b;\n');
  const before = ledgerFiles(dir);
  const r = tnt(dir, 'verify', '--integrated');
  assert.equal(r.code, 1);
  assert.match(r.out, /test: exit 1/);
  assert.match(r.out, /F-001 AC-1.*expected output no longer observed/);
  assert.deepEqual(ledgerFiles(dir), before);
  assert.equal(git(dir, 'status', '--porcelain').stdout.trim(), 'M app.mjs');
});

test('integrated verify writes logs and a summary to --out', () => {
  const dir = makeProject();
  driveTo(dir, 'audit');
  const out = path.join(dir, '..', path.basename(dir) + '-ci');
  const r = tnt(dir, 'verify', '--integrated', '--out', out);
  assert.equal(r.code, 0, r.out);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.features, ['F-001']);
  for (const run of summary.runs) assert.ok(fs.existsSync(path.join(out, run.log)), run.log);
});

test('integrated verify fails while a started feature is unfinished', () => {
  const dir = makeProject();
  driveTo(dir, 'green');
  const r = tnt(dir, 'verify', '--integrated');
  assert.equal(r.code, 1);
  assert.match(r.out, /F-001 is not done \(phase green\)/);
});

test('sync onto a merged base resets to red and limits the review to the feature diff', () => {
  const dir = makeProject();
  const main = branch(dir);
  const fd = driveTo(dir, 'style');
  const feat = branch(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'wip: style evidence');
  assert.equal(git(dir, 'checkout', '-q', main).code, 0);
  write(dir, 'other.mjs', 'export const other = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'other work');
  git(dir, 'checkout', '-q', feat);
  assert.equal(git(dir, 'merge', '-q', '--no-edit', main).code, 0);

  // --onto defaults to the branch the feature was started from
  const s = tnt(dir, 'sync', 'F-001');
  assert.equal(s.code, 0, s.out);
  const st = JSON.parse(tnt(dir, 'status', 'F-001', '--json').stdout);
  assert.equal(st.baseBranch, main);
  assert.equal(st.syncedBase, git(dir, 'rev-parse', main).stdout.trim());
  assert.equal(st.phase, 'red');
  assert.equal(st.gates.green, undefined);

  tnt(dir, 'run', 'F-001', 'green');
  assert.equal(tnt(dir, 'gate', 'F-001', 'green').code, 0);
  tnt(dir, 'run', 'F-001', 'style');
  assert.equal(tnt(dir, 'gate', 'F-001', 'style').code, 0);
  write(dir, path.join(fd, 'review.draft.json'), JSON.stringify({
    verdict: 'approve', files_reviewed: ['app.mjs', 'app.test.mjs'], findings: [],
  }));
  const rv = tnt(dir, 'review', 'submit', 'F-001', path.join(fd, 'review.draft.json'));
  assert.equal(rv.code, 0, rv.out);
  assert.ok(ledgerOf(dir, fd).some((e) => e.type === 'sync'));
});

test('sync refuses a base that is not merged into HEAD', () => {
  const dir = makeProject();
  const main = branch(dir);
  driveTo(dir, 'green');
  const feat = branch(dir);
  assert.equal(git(dir, 'checkout', '-q', main).code, 0);
  write(dir, 'other.mjs', 'export const other = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'other work');
  git(dir, 'checkout', '-q', feat);
  const r = tnt(dir, 'sync', 'F-001', '--onto', main);
  assert.equal(r.code, 2);
  assert.match(r.out, /not merged into HEAD/);
});

test('sync refuses changed locked tests unless a human relocks them', () => {
  const dir = makeProject();
  const main = branch(dir);
  const fd = driveTo(dir, 'green');
  write(dir, 'app.test.mjs', TEST_FILE + '// upstream change\n');
  git(dir, 'commit', '-q', '-am', 'merge upstream test change');
  const r = tnt(dir, 'sync', 'F-001', '--onto', main);
  assert.equal(r.code, 2);
  assert.match(r.out, /app\.test\.mjs/);
  assert.match(r.out, /--relock/);
  const noBy = tnt(dir, 'sync', 'F-001', '--onto', main, '--relock', '--reason', 'upstream');
  assert.equal(noBy.code, 2);
  const ok = tnt(dir, 'sync', 'F-001', '--onto', main, '--relock', '--by', 'Tester', '--reason', 'upstream test change');
  assert.equal(ok.code, 0, ok.out);
  const e = ledgerOf(dir, fd).find((x) => x.type === 'sync');
  assert.equal(e.by, 'Tester');
  assert.deepEqual(Object.keys(e.relocked), ['app.test.mjs']);
  tnt(dir, 'run', 'F-001', 'green');
  const g = tnt(dir, 'gate', 'F-001', 'green');
  assert.equal(g.code, 0, g.out);
});
