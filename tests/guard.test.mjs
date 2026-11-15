import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sh, GUARD, makeProject, driveTo } from './helpers.mjs';

const hook = (dir, payload) => sh(process.execPath, [GUARD], dir, JSON.stringify({ cwd: dir, ...payload }));

test('blocks direct writes to the ledger and evidence', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'spec');
  let r = hook(dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, '.tnt', 'ledger.jsonl') } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(fd, 'state.json') } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Bash', tool_input: { command: `echo '{}' >> .tnt/ledger.jsonl` } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Write', tool_input: { file_path: path.join(fd, 'ledger.jsonl') } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, '.tnt', '_project', 'ledger.jsonl') } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Bash', tool_input: { command: `echo '{}' >> ${fd.replace(/\\/g, '/')}/ledger.jsonl` } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Bash', tool_input: { command: `cp x .tnt/_project/evidence/0001-baseline-test.log` } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, '.tnt', 'view.html') } });
  assert.equal(r.code, 2);
});

test('allows the spec, drafts and normal source files', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'spec');
  for (const file of [path.join(fd, 'spec.md'), path.join(fd, 'review.draft.json'), 'src/app.mjs']) {
    assert.equal(hook(dir, { tool_name: 'Write', tool_input: { file_path: file } }).code, 0, file);
  }
  assert.equal(hook(dir, { tool_name: 'Bash', tool_input: { command: 'cat .tnt/ledger.jsonl 2>&1 | head' } }).code, 0);
});

test('read-only commands with arrows, comparisons and quoted > are allowed', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const cmds = [
    `node -e "for (const l of require('fs').readFileSync('.tnt/ledger.jsonl','utf8').split('\\n')) { const e = JSON.parse(l); if (e.seq >= 3) console.log(e) }"`,
    `tail -n 10 .tnt/ledger.jsonl | node -e 'process.stdin.on("data", d => console.log(String(d)))'`,
    `for n in 1 2; do sed -n "\${n}p" .tnt/ledger.jsonl; done 2>&1 | head`,
    `grep -c "AC-1" app.test.mjs && echo "a > b" `,
  ];
  for (const command of cmds) assert.equal(hook(dir, { tool_name: 'Bash', tool_input: { command } }).code, 0, command);
});

test('writes hidden in scripts or quoted paths are still blocked', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const cmds = [
    `node -e "require('fs').appendFileSync('.tnt/ledger.jsonl', 'x')"`,
    `cat x > ".tnt/ledger.jsonl"`,
    `cp /tmp/x app.test.mjs`,
  ];
  for (const command of cmds) assert.equal(hook(dir, { tool_name: 'Bash', tool_input: { command } }).code, 2, command);
});

test('locked tests become read-only after the red gate', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  assert.equal(hook(dir, { tool_name: 'Edit', tool_input: { file_path: 'app.test.mjs' } }).code, 2);
  assert.equal(hook(dir, { tool_name: 'Bash', tool_input: { command: "sed -i 's/5/6/' app.test.mjs" } }).code, 2);
  assert.equal(hook(dir, { tool_name: 'Write', tool_input: { file_path: 'app.mjs' } }).code, 0);
});

test('verifier subagents may only write their own drafts', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'spec');
  const as = (agent_type, file) => hook(dir, { agent_type, tool_name: 'Write', tool_input: { file_path: file } }).code;
  assert.equal(as('tnt:code-reviewer', 'app.mjs'), 2);
  assert.equal(as('tnt:code-reviewer', path.join(fd, 'review.draft.json')), 0);
  assert.equal(as('tnt:evidence-auditor', path.join(fd, 'review.draft.json')), 2);
  assert.equal(as('tnt:implementer', 'app.mjs'), 0);
});

const CLI = 'node "/home/u/.claude/plugins/tnt/scripts/tnt.mjs"';

test('subagents cannot run the orchestrator or human tnt commands', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const as = (command) => hook(dir, { agent_id: 'a1', agent_type: 'tnt:implementer', tool_name: 'Bash', tool_input: { command } });
  for (const sub of ['approve F-001 --by Ismar', 'waive F-001 audit --by Ismar --reason x', 'unlock F-001 --reason x',
    'gate F-001 green', 'sync F-001 --onto main', 'sync F-001 --relock --by Ismar --reason x', 'start F-001', 'init']) {
    const r = as(`${CLI} ${sub}`);
    assert.equal(r.code, 2, sub);
    assert.match(r.stderr, /belongs to the orchestrator or a person/);
  }
  assert.equal(as(`${CLI} status F-001 --json && ${CLI} gate F-001 green`).code, 2, 'chained');
  assert.equal(as(`node -e "import('/p/scripts/lib/harness.mjs').then(h => h.waive())"`).code, 2, 'harness import');
  for (const sub of ['check F-001 green', 'run F-001 green', 'status F-001 --json', 'lock-tests F-001 a.test.mjs',
    'review submit F-001 x.json', 'new "Add numbers"', 'ledger verify', 'verify F-001']) {
    assert.equal(as(`${CLI} ${sub}`).code, 0, sub);
  }
  // agent_type alone also marks a subagent (older Claude Code versions)
  assert.equal(hook(dir, { agent_type: 'tnt:code-reviewer', tool_name: 'Bash', tool_input: { command: `${CLI} approve F-001 --by X` } }).code, 2);
});

test('human decisions in the main session go to a permission prompt', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const main = (command) => hook(dir, { tool_name: 'Bash', tool_input: { command } });
  for (const sub of ['approve F-001 --by Ismar', 'waive F-001 audit --by Ismar --reason x', 'unlock F-001 --reason x',
    'sync F-001 --onto main --relock --by Ismar --reason x']) {
    const r = main(`${CLI} ${sub}`);
    assert.equal(r.code, 0, sub);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.equal(out.permissionDecision, 'ask', sub);
    assert.match(out.permissionDecisionReason, /human decision/);
  }
  for (const sub of ['gate F-001 green', 'sync F-001 --onto main', 'status F-001 --json', 'start F-001']) {
    const r = main(`${CLI} ${sub}`);
    assert.equal(r.code, 0, sub);
    assert.equal(r.stdout, '', sub);
  }
});

test('subagents cannot run git commands that rewrite history or discard changes', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const as = (command) => hook(dir, { agent_id: 'a1', agent_type: 'tnt:implementer', tool_name: 'Bash', tool_input: { command } });
  for (const command of ['git push', 'git -C . commit -m "fix"', 'git reset --hard HEAD~1', 'git checkout -- src.mjs',
    'git stash', 'git clean -fd', 'git restore src.mjs', 'git branch -D tnt/x', 'git --no-pager rebase main',
    'git status && git merge main', 'git switch main', 'git tag v1']) {
    const r = as(command);
    assert.equal(r.code, 2, command);
    assert.match(r.stderr, /not a step's job/);
  }
  for (const command of ['git status --porcelain', `git diff main -- . ':(exclude).tnt'`, 'git log --oneline -5',
    'git show HEAD:app.mjs', 'git branch --show-current', 'git diff --name-only main', 'grep -n "git push" README.md',
    'cat .git/HEAD', 'git merge-base --is-ancestor main HEAD']) {
    assert.equal(as(command).code, 0, command);
  }
  // the orchestrator in the main session still merges the base branch
  assert.equal(hook(dir, { tool_name: 'Bash', tool_input: { command: 'git merge --no-edit main' } }).code, 0);
});

test('git checkout or restore of a locked test is blocked even in the main session', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const main = (command) => hook(dir, { tool_name: 'Bash', tool_input: { command } });
  assert.equal(main('git checkout HEAD~1 -- app.test.mjs').code, 2);
  assert.equal(main('git restore app.test.mjs').code, 2);
  assert.equal(main('install -m 644 /tmp/x app.test.mjs').code, 2);
  assert.equal(main('git checkout -- app.mjs').code, 0);
});

test('does nothing outside a think-and-type project', () => {
  const r = sh(process.execPath, [GUARD], path.parse(process.cwd()).root, JSON.stringify({ cwd: path.parse(process.cwd()).root, tool_name: 'Write', tool_input: { file_path: 'x' } }));
  assert.equal(r.code, 0);
});
