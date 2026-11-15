import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tnt, git, write, read, sh, GUARD, makeProject, branch, ledgerOf, SPEC, APP, FUNCTIONAL_CMD } from './helpers.mjs';

const PR_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './app.mjs';
test('adds two numbers', () => assert.equal(add(2, 3), 5));
`;

const must = (r) => { if (r.code !== 0) throw new Error(r.out); return r; };

// A repo with someone else's change on branch "pr" (built without tnt), and a
// review of it created, approved and started with the change checked out.
function prReview({ broken = false } = {}) {
  const dir = makeProject();
  const base = branch(dir);
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, 'app.mjs', broken ? 'export const add = (a, b) => a - b;\n' : APP);
  write(dir, 'app.test.mjs', PR_TEST);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'add numbers');
  git(dir, 'checkout', '-q', base);
  const created = JSON.parse(must(tnt(dir, 'review', 'new', 'Add numbers PR', '--target', 'pr', '--base', base, '--json')).stdout);
  const id = created.id;
  write(dir, path.join(created.dir, 'spec.md'), SPEC.replace('# F-001', `# ${id}`));
  must(tnt(dir, 'approve', id, '--by', 'Reviewer'));
  return { dir, id, rdir: created.dir, base, commit: created.commit };
}
const start = (ctx) => { git(ctx.dir, 'switch', '-q', '--detach', 'pr'); must(tnt(ctx.dir, 'start', ctx.id)); };
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

test('a good change passes every check, gets an approve verdict, and nothing is committed', () => {
  const ctx = prReview();
  const before = commits(ctx.dir);
  start(ctx);
  const { dir, id } = ctx;
  must(tnt(dir, 'run', id, 'tests'));
  assert.match(must(tnt(dir, 'gate', id, 'tests')).out, /check tests for R-\w+: PASS/);
  must(tnt(dir, 'run', id, 'style'));
  must(tnt(dir, 'gate', id, 'style'));
  review(ctx, { verdict: 'approve' });
  must(tnt(dir, 'gate', id, 'review'));
  must(tnt(dir, 'run', id, 'functional', '--ac', 'AC-1', '--expect', 'sum=5', '--', FUNCTIONAL_CMD));
  must(tnt(dir, 'gate', id, 'functional'));
  audit(ctx);
  const g = must(tnt(dir, 'gate', id, 'audit'));
  assert.match(g.out, /verdict: approve/);
  const s = JSON.parse(tnt(dir, 'status', id, '--json').stdout);
  assert.equal(s.phase, 'done');
  assert.equal(s.verdict, 'approve');
  assert.match(read(dir, path.join(ctx.rdir, 'report.md')), /Verdict: \*\*APPROVE\*\*/);
  assert.equal(commits(dir), before, 'a review never commits');
  assert.equal(git(dir, 'rev-parse', 'HEAD').stdout.trim(), ctx.commit);
  assert.equal(must(tnt(dir, 'ledger', 'verify')).code, 0);
  assert.equal(git(dir, 'check-ignore', '-q', path.join(ctx.rdir, 'ledger.jsonl')).code, 0, 'reviews stay local');
});

test('a broken change still gets every check decided, with findings and a changes_requested verdict', () => {
  const ctx = prReview({ broken: true });
  start(ctx);
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
  const ctx = prReview();
  start(ctx);
  const { dir, id } = ctx;
  write(dir, 'node_modules/out.txt', 'sum=5\n');
  must(tnt(dir, 'run', id, 'tests'));
  must(tnt(dir, 'gate', id, 'tests'));
  must(tnt(dir, 'run', id, 'style'));
  must(tnt(dir, 'gate', id, 'style'));
  review(ctx, { verdict: 'approve' });
  must(tnt(dir, 'gate', id, 'review'));
  must(tnt(dir, 'run', id, 'functional', '--ac', 'AC-1', '--expect', 'sum=\\d', '--', 'cat node_modules/out.txt'));
  must(tnt(dir, 'gate', id, 'functional'));
  write(dir, 'node_modules/out.txt', 'sum=6\n');
  const v = tnt(dir, 'verify', id);
  assert.equal(v.code, 1);
  assert.match(v.out, /functional AC-1 \(#\d+, re-run #\d+\): claimed outcome \/sum=5\/ no longer observed/);
});

test('checks stay undecided while evidence is missing or was recorded on other code', () => {
  const ctx = prReview();
  const { dir, id } = ctx;
  const early = tnt(dir, 'start', id);
  assert.equal(early.code, 2);
  assert.match(early.out, /check out the change first: git switch --detach/);
  start(ctx);
  const g = tnt(dir, 'gate', id, 'tests');
  assert.equal(g.code, 1);
  assert.match(g.out, /NOT DECIDED[\s\S]*no tests run recorded[\s\S]*attempt 1\/3/);
  write(dir, 'app.mjs', 'export const add = (a, b) => a + b + 0;\n');
  must(tnt(dir, 'run', id, 'tests'));
  const moved = tnt(dir, 'gate', id, 'tests');
  assert.equal(moved.code, 1);
  assert.match(moved.out, /the working tree is not the change under review/);
});

test('feature-only commands are refused for a review', () => {
  const ctx = prReview();
  start(ctx);
  const { dir, id } = ctx;
  assert.match(tnt(dir, 'run', id, 'red').out, /is a review: record the suite with `tnt run R-\w+ tests`/);
  assert.match(tnt(dir, 'lock-tests', id, 'app.test.mjs').out, /applies to features only/);
  assert.match(tnt(dir, 'unlock', id, '--reason', 'x').out, /applies to features only/);
  assert.match(tnt(dir, 'gate', id, 'green').out, /unknown check "green" for a review/);
});

test('the viewer and status list reviews', () => {
  const ctx = prReview({ broken: true });
  start(ctx);
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

test('the guard protects review evidence and confines the claims analyst', () => {
  const ctx = prReview();
  const { dir, rdir } = ctx;
  const hook = (payload) => sh(process.execPath, [GUARD], dir, JSON.stringify({ cwd: dir, ...payload })).code;
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: path.join(dir, rdir, 'ledger.jsonl') } }), 2);
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: `echo x >> ${rdir.replace(/\\/g, '/')}/state.json` } }), 2);
  const as = (agent, file) => hook({ agent_id: 'a', agent_type: `tnt:${agent}`, tool_name: 'Write', tool_input: { file_path: path.join(dir, file) } });
  assert.equal(as('claims-analyst', path.join(rdir, 'spec.md')), 0);
  assert.equal(as('claims-analyst', 'app.mjs'), 2);
  assert.equal(as('code-reviewer', path.join(rdir, 'review.draft.json')), 0);
  assert.equal(as('functional-tester', path.join(rdir, 'functional', 'probe.sh')), 0);
});
