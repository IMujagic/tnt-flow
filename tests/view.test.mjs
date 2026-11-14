// `tnt view`: a self-contained HTML page that shows the ledger as a timeline,
// with the code diff wherever the recorded tree changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tnt, git, read, makeProject, driveTo } from './helpers.mjs';

const dataOf = (html) => {
  const m = html.match(/<script type="application\/json" id="tnt-data">([\s\S]*?)<\/script>/);
  assert.ok(m, 'embedded data block');
  return JSON.parse(m[1]);
};

test('view writes a git-ignored page with every ledger entry and the diff between recorded trees', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'green');
  const r = tnt(dir, 'view');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\.tnt\/view\.html/);
  assert.equal(git(dir, 'check-ignore', '-q', '.tnt/view.html').code, 0);

  const data = dataOf(read(dir, '.tnt/view.html'));
  const f = data.features.find((x) => x.id === 'F-001');
  const ledgerLines = read(dir, path.join(fd, 'ledger.jsonl')).trim().split('\n').length;
  assert.equal(f.entries.length, ledgerLines);
  assert.equal(f.integrity.ok, true);

  const runs = f.entries.filter((e) => e.type === 'run');
  assert.ok(runs.every((e) => typeof e.logText === 'string' && e.logText.includes('---- stdout ----')));

  // base -> red adds the test, red -> green adds the implementation
  const toRed = f.transitions.find((t) => t.files.some((x) => x.file === 'app.test.mjs'));
  assert.ok(toRed, 'transition that adds the test');
  const toGreen = f.transitions.find((t) => t.files.some((x) => x.file === 'app.mjs'));
  assert.ok(toGreen, 'transition that adds the implementation');
  assert.match(toGreen.patch, /\+export const add/);
  assert.ok(!toGreen.files.some((x) => x.file.startsWith('.tnt/')), 'harness files are not part of code diffs');
});

test('view marks tampered entries instead of hiding them', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'green');
  const file = path.join(dir, fd, 'ledger.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const idx = lines.findIndex((l) => l.includes('"step":"red"'));
  lines[idx] = lines[idx].replace('"exit":1', '"exit":0');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.equal(tnt(dir, 'view').code, 0);
  const f = dataOf(read(dir, '.tnt/view.html')).features[0];
  assert.equal(f.integrity.ok, false);
  const bad = f.entries.find((e) => e.type === 'run' && e.step === 'red');
  assert.match(bad.problems.join(' '), /content hash mismatch/);
});

test('view embeds command output safely and honours a feature filter and --out', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  tnt(dir, 'run', 'F-001', 'probe', '--', `node -e "console.log('</script><b>x</b>')"`);
  const out = path.join(dir, '..', path.basename(dir) + '-view.html');
  const r = tnt(dir, 'view', 'F-001', '--out', out);
  assert.equal(r.code, 0, r.out);
  const html = fs.readFileSync(out, 'utf8');
  const opened = (html.match(/<script\b/g) || []).length;
  const closed = (html.match(/<\/script>/gi) || []).length;
  assert.equal(closed, opened, 'command output must not close a script element');
  const data = dataOf(html);
  assert.deepEqual(data.features.map((x) => x.id), ['F-001']);
  assert.ok(data.features[0].entries.some((e) => e.logText?.includes('</script><b>x</b>')));
});

test('integrated verify --out also writes a viewer page', () => {
  const dir = makeProject();
  driveTo(dir, 'audit');
  const out = path.join(dir, '..', path.basename(dir) + '-ci');
  assert.equal(tnt(dir, 'verify', '--integrated', '--out', out).code, 0);
  assert.ok(fs.existsSync(path.join(out, 'view.html')));
  assert.equal(git(dir, 'status', '--porcelain').stdout, '');
});
