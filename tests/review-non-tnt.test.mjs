import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tnt, git, write, read, sh, GUARD, makeProject, branch, ledgerOf, SPEC, APP, FUNCTIONAL_CMD } from './helpers.mjs';

const PR_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './app.mjs';
test('adds two numbers', () => assert.equal(add(2, 3), 5));
`;

const must = (r) => { if (r.code !== 0) throw new Error(r.out); return r; };
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };
const withConfig = (dir, edit) => { const c = JSON.parse(read(dir, '.tnt/config.json')); edit(c); return JSON.stringify(c, null, 2); };

// Someone else's change on branch "pr" (built without tnt); optionally the base
// branch moves on afterwards. Then a review of it is created and its claims approved.
function prReview({ broken = false, prFiles = {}, baseFiles = {}, headOnly = false } = {}) {
  const dir = makeProject();
  const base = branch(dir);
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, 'app.mjs', broken ? 'export const add = (a, b) => a - b;\n' : APP);
  write(dir, 'app.test.mjs', PR_TEST);
  for (const [f, c] of Object.entries(prFiles)) write(dir, f, typeof c === 'function' ? c(dir) : c);
  commit(dir, 'add numbers');
  git(dir, 'checkout', '-q', base);
  if (Object.keys(baseFiles).length) {
    for (const [f, c] of Object.entries(baseFiles)) write(dir, f, typeof c === 'function' ? c(dir) : c);
    commit(dir, 'base moves on');
  }
  const args = ['review', 'new', 'Add numbers PR', '--target', 'pr', '--base', base, '--json', ...(headOnly ? ['--head-only'] : [])];
  const created = JSON.parse(must(tnt(dir, ...args)).stdout);
  write(dir, path.join(created.dir, 'spec.md'), SPEC.replace('# F-001', `# ${created.id}`));
  must(tnt(dir, 'approve', created.id, '--by', 'Reviewer'));
  return { dir, id: created.id, rdir: created.dir, base, created, head: git(dir, 'rev-parse', 'HEAD').stdout.trim() };
}
function start(ctx, ...extra) {
  must(tnt(ctx.dir, 'start', ctx.id, ...extra));
  ctx.wd = JSON.parse(tnt(ctx.dir, 'status', ctx.id, '--json').stdout).workdir;
  return ctx;
}
const commits = (dir) => git(dir, 'rev-list', '--all', '--count').stdout.trim();

function review(ctx, draft) {
  write(ctx.dir, path.join(ctx.rdir, 'review.draft.json'), JSON.stringify({ summary: 'ok', files_reviewed: ['app.mjs', 'app.test.mjs'], findings: [], ...draft }));
  must(tnt(ctx.dir, 'review', 'submit', ctx.id, path.join(ctx.rdir, 'review.draft.json')));
}
function audit(ctx) {
  must(tnt(ctx.dir, 'verify', ctx.id));
  write(ctx.dir, path.join(ctx.rdir, 'audit.draft.json'), JSON.stringify({ verdict: 'pass', checks: [{ name: 'evidence supports each check', result: 'pass', evidence: '#1' }] }));
  must(tnt(ctx.dir, 'audit', 'submit', ctx.id, path.join(ctx.rdir, 'audit.draft.json')));
}
function throughStyle(ctx) {
  must(tnt(ctx.dir, 'run', ctx.id, 'tests'));
  must(tnt(ctx.dir, 'gate', ctx.id, 'tests'));
  must(tnt(ctx.dir, 'run', ctx.id, 'style'));
  must(tnt(ctx.dir, 'gate', ctx.id, 'style'));
}

test('a good change passes every check in its own worktree; your checkout is never touched', () => {
  const ctx = prReview();
  const before = commits(ctx.dir);
  start(ctx);
  const { dir, id } = ctx;
  assert.ok(ctx.wd && !path.resolve(ctx.wd).startsWith(path.resolve(dir)), 'the worktree is outside this checkout');
  assert.equal(fs.existsSync(path.join(dir, 'app.mjs')), false, 'the change is not in your checkout');
  throughStyle(ctx);
  review(ctx, { verdict: 'approve' });
  must(tnt(dir, 'gate', id, 'review'));
  must(tnt(dir, 'run', id, 'functional', '--ac', 'AC-1', '--expect', 'sum=5', '--', FUNCTIONAL_CMD));
  must(tnt(dir, 'gate', id, 'functional'));
  audit(ctx);
  assert.match(must(tnt(dir, 'gate', id, 'audit')).out, /verdict: approve/);
  const report = read(dir, path.join(ctx.rdir, 'report.md'));
  assert.match(report, /Verdict: \*\*APPROVE\*\*/);
  assert.match(report, /Reviewed: the change merged into/);
  assert.match(report, /Config applied: \.tnt\/config\.json at the base commit/);
  assert.equal(commits(dir), before, 'a review never commits to your repository');
  assert.equal(git(dir, 'rev-parse', 'HEAD').stdout.trim(), ctx.head, 'your HEAD and branch are unchanged');
  assert.equal(branch(dir), ctx.base);
  assert.equal(fs.existsSync(ctx.wd), false, 'the worktree is removed after the audit');
  assert.equal(must(tnt(dir, 'ledger', 'verify')).code, 0);
  assert.equal(git(dir, 'check-ignore', '-q', path.join(ctx.rdir, 'ledger.jsonl')).code, 0, 'reviews stay local');
  must(tnt(dir, 'start', id));
  assert.equal(must(tnt(dir, 'verify', id)).code, 0, 'start rebuilds the same code, and verify runs again');
});

test('the change cannot pick its own checks: its .tnt/ edits are ignored and reported as blocking', () => {
  const ctx = prReview({
    broken: true,
    prFiles: { '.tnt/config.json': (dir) => withConfig(dir, (c) => { c.commands.test = 'echo "all 12 tests passed"'; c.functional = { requireSpecExpect: false }; }) },
  });
  assert.deepEqual(ctx.created.tntChanges, ['.tnt/config.json']);
  start(ctx);
  const { dir, id } = ctx;
  must(tnt(dir, 'run', id, 'tests'));
  const t = must(tnt(dir, 'gate', id, 'tests'));
  assert.match(t.out, /FINDINGS[\s\S]*the test suite fails on this change/, 'the base config ran the real suite');
  const run = ledgerOf(dir, ctx.rdir).findLast((e) => e.type === 'run' && e.step === 'tests');
  assert.equal(run.cmd, 'node --test');
  must(tnt(dir, 'run', id, 'style'));
  must(tnt(dir, 'gate', id, 'style'));
  review(ctx, { verdict: 'approve' });
  const g = must(tnt(dir, 'gate', id, 'review'));
  assert.match(g.out, /FINDINGS[\s\S]*blocking: the change modifies tnt's own files \(\.tnt\/config\.json\)/);
});

test('by default the review runs on the merge result, with --head-only on the change itself', () => {
  const merged = start(prReview({ baseFiles: { 'base-only.txt': 'landed on the base after the PR branched\n' } }));
  assert.equal(fs.existsSync(path.join(merged.wd, 'base-only.txt')), true);
  assert.equal(fs.existsSync(path.join(merged.wd, 'app.mjs')), true);
  const own = start(prReview({ baseFiles: { 'base-only.txt': 'x\n' }, headOnly: true }));
  assert.equal(fs.existsSync(path.join(own.wd, 'base-only.txt')), false);
  assert.equal(fs.existsSync(path.join(own.wd, 'app.mjs')), true);
});

test('a merge conflict is recorded as a blocking finding, and the change can still be reviewed on its own commit', () => {
  const ctx = prReview({ baseFiles: { 'app.mjs': 'export const add = (a, b) => b + a;\n' } });
  const s = tnt(ctx.dir, 'start', ctx.id);
  assert.equal(s.code, 2);
  assert.match(s.out, /does not merge cleanly into .*\(app\.mjs\)[\s\S]*--head-only/);
  assert.deepEqual(ledgerOf(ctx.dir, ctx.rdir).find((e) => e.type === 'merge-conflict').files, ['app.mjs']);
  start(ctx, '--head-only');
  throughStyle(ctx);
  review(ctx, { verdict: 'approve' });
  assert.match(must(tnt(ctx.dir, 'gate', ctx.id, 'review')).out, /blocking: the change does not merge cleanly/);
});

test('review.setup from the trusted config prepares the worktree and is recorded', () => {
  const setup = `node -e "require('fs').mkdirSync('node_modules', { recursive: true }); require('fs').writeFileSync('node_modules/ready', '1')"`;
  const ctx = start(prReview({ baseFiles: { '.tnt/config.json': (dir) => withConfig(dir, (c) => { c.review = { setup }; }) } }));
  assert.equal(fs.existsSync(path.join(ctx.wd, 'node_modules', 'ready')), true);
  const run = ledgerOf(ctx.dir, ctx.rdir).find((e) => e.type === 'run' && e.step === 'setup');
  assert.equal(run.exit, 0);
});

test('--local-config snapshots this checkout\'s config instead of the base commit\'s', () => {
  const dir = makeProject();
  const base = branch(dir);
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, 'app.mjs', APP);
  commit(dir, 'add');
  git(dir, 'checkout', '-q', base);
  write(dir, '.tnt/config.json', withConfig(dir, (c) => { c.review = { setup: 'node -e "1"' }; })); // uncommitted, the reviewer's own
  const fromBase = JSON.parse(must(tnt(dir, 'review', 'new', 'A', '--target', 'pr', '--json')).stdout);
  const fromLocal = JSON.parse(must(tnt(dir, 'review', 'new', 'B', '--target', 'pr', '--local-config', '--json')).stdout);
  assert.match(fromBase.configSource, /at the base commit/);
  assert.match(fromLocal.configSource, /--local-config/);
  assert.equal(JSON.parse(read(dir, path.join(fromBase.dir, 'config.json'))).review?.setup ?? null, null);
  assert.equal(JSON.parse(read(dir, path.join(fromLocal.dir, 'config.json'))).review.setup, 'node -e "1"');
});

test('a broken change still gets every check decided, with findings and a changes_requested verdict', () => {
  const ctx = start(prReview({ broken: true }));
  const { dir, id } = ctx;
  must(tnt(dir, 'run', id, 'tests'));
  const t = tnt(dir, 'gate', id, 'tests');
  assert.equal(t.code, 0, 'a decided check exits 0 even with findings');
  assert.match(t.out, /FINDINGS[\s\S]*the test suite fails on this change/);
  must(tnt(dir, 'run', id, 'style'));
  must(tnt(dir, 'gate', id, 'style'));
  review(ctx, { verdict: 'changes_requested', findings: [{ id: 'R1', severity: 'major', file: 'app.mjs', line: 1, quote: 'export const add = (a, b) => a - b;', issue: 'subtracts instead of adding' }] });
  assert.match(must(tnt(dir, 'gate', id, 'review')).out, /review #\d+ requested changes \(0 blocking, 1 major/);
  must(tnt(dir, 'run', id, 'functional', '--ac', 'AC-1', '--expect', 'sum=', '--', FUNCTIONAL_CMD));
  assert.match(must(tnt(dir, 'gate', id, 'functional')).out, /AC-1: the claimed outcome \/sum=5\/ was not observed/);
  audit(ctx);
  assert.match(must(tnt(dir, 'gate', id, 'audit')).out, /verdict: changes_requested/);
  const report = read(dir, path.join(ctx.rdir, 'report.md'));
  assert.match(report, /Verdict: \*\*CHANGES REQUESTED\*\*/);
  assert.match(report, /## Findings[\s\S]*\*\*tests\*\*: the test suite fails/);
  assert.match(report, /## Code review findings[\s\S]*major `app\.mjs:1`: subtracts instead of adding/);
});

test('verify reproduces failures and flags outcomes that flip', () => {
  const ctx = start(prReview());
  const { dir, id } = ctx;
  write(ctx.wd, 'node_modules/out.txt', 'sum=5\n');
  throughStyle(ctx);
  review(ctx, { verdict: 'approve' });
  must(tnt(dir, 'gate', id, 'review'));
  must(tnt(dir, 'run', id, 'functional', '--ac', 'AC-1', '--expect', 'sum=\\d', '--', 'cat node_modules/out.txt'));
  must(tnt(dir, 'gate', id, 'functional'));
  write(ctx.wd, 'node_modules/out.txt', 'sum=6\n');
  const v = tnt(dir, 'verify', id);
  assert.equal(v.code, 1);
  assert.match(v.out, /functional AC-1 \(#\d+, re-run #\d+\): claimed outcome \/sum=5\/ no longer observed/);
});

test('checks stay undecided while evidence is missing or was recorded on other code', () => {
  const ctx = prReview();
  const { dir, id } = ctx;
  assert.match(tnt(dir, 'run', id, 'tests').out, /review worktree is missing; run `tnt start/);
  start(ctx);
  const g = tnt(dir, 'gate', id, 'tests');
  assert.equal(g.code, 1);
  assert.match(g.out, /NOT DECIDED[\s\S]*no tests run recorded[\s\S]*attempt 1\/3/);
  write(ctx.wd, 'app.mjs', 'export const add = (a, b) => a + b + 0;\n');
  must(tnt(dir, 'run', id, 'tests'));
  const moved = tnt(dir, 'gate', id, 'tests');
  assert.equal(moved.code, 1);
  assert.match(moved.out, /the working tree is not the change under review/);
});

test('feature-only commands are refused for a review', () => {
  const ctx = start(prReview());
  const { dir, id } = ctx;
  assert.match(tnt(dir, 'run', id, 'red').out, /is a review: record the suite with `tnt run R-\w+ tests`/);
  assert.match(tnt(dir, 'lock-tests', id, 'app.test.mjs').out, /applies to features only/);
  assert.match(tnt(dir, 'unlock', id, '--reason', 'x').out, /applies to features only/);
  assert.match(tnt(dir, 'gate', id, 'green').out, /unknown check "green" for a review/);
  must(tnt(dir, 'review', 'close', id));
  assert.equal(fs.existsSync(ctx.wd), false);
});

test('the viewer and status list reviews', () => {
  const ctx = start(prReview({ broken: true }));
  const { dir, id } = ctx;
  must(tnt(dir, 'run', id, 'tests'));
  must(tnt(dir, 'gate', id, 'tests'));
  must(tnt(dir, 'view'));
  const page = read(dir, '.tnt/view.html');
  assert.ok(page.includes(id));
  assert.ok(page.includes('the test suite fails on this change'));
  assert.match(must(tnt(dir, 'status')).out, new RegExp(`reviews of non-tnt changes[\\s\\S]*${id}`));
  assert.equal(ledgerOf(dir, ctx.rdir)[0].type, 'review-created');
});

test('the guard protects review evidence and the config snapshot, and confines the claims analyst', () => {
  const ctx = prReview();
  const { dir, rdir } = ctx;
  const hook = (payload) => sh(process.execPath, [GUARD], dir, JSON.stringify({ cwd: dir, ...payload })).code;
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: path.join(dir, rdir, 'ledger.jsonl') } }), 2);
  assert.equal(hook({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, rdir, 'config.json') } }), 2);
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: `echo x >> ${rdir.replace(/\\/g, '/')}/config.json` } }), 2);
  const as = (agent, file) => hook({ agent_id: 'a', agent_type: `tnt:${agent}`, tool_name: 'Write', tool_input: { file_path: path.join(dir, file) } });
  assert.equal(as('claims-analyst', path.join(rdir, 'spec.md')), 0);
  assert.equal(as('claims-analyst', 'app.mjs'), 2);
  assert.equal(as('code-reviewer', path.join(rdir, 'review.draft.json')), 0);
  assert.equal(as('functional-tester', path.join(rdir, 'functional', 'probe.sh')), 0);
});
