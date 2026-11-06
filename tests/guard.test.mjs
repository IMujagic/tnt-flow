import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sh, GUARD, makeProject, driveTo } from './helpers.mjs';

const hook = (dir, payload) => sh(process.execPath, [GUARD], dir, JSON.stringify({ cwd: dir, ...payload }));

test('blocks direct writes to the ledger and evidence', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'spec');
  let r = hook(dir, { tool_name: 'Write', tool_input: { file_path: path.join(dir, '.agentic-wf', 'ledger.jsonl') } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Edit', tool_input: { file_path: path.join(fd, 'state.json') } });
  assert.equal(r.code, 2);
  r = hook(dir, { tool_name: 'Bash', tool_input: { command: `echo '{}' >> .agentic-wf/ledger.jsonl` } });
  assert.equal(r.code, 2);
});

test('allows the spec, drafts and normal source files', () => {
  const dir = makeProject();
  const fd = driveTo(dir, 'spec');
  for (const file of [path.join(fd, 'spec.md'), path.join(fd, 'review.draft.json'), 'src/app.mjs']) {
    assert.equal(hook(dir, { tool_name: 'Write', tool_input: { file_path: file } }).code, 0, file);
  }
  assert.equal(hook(dir, { tool_name: 'Bash', tool_input: { command: 'cat .agentic-wf/ledger.jsonl 2>&1 | head' } }).code, 0);
});

test('read-only commands with arrows, comparisons and quoted > are allowed', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const cmds = [
    `node -e "for (const l of require('fs').readFileSync('.agentic-wf/ledger.jsonl','utf8').split('\\n')) { const e = JSON.parse(l); if (e.seq >= 3) console.log(e) }"`,
    `tail -n 10 .agentic-wf/ledger.jsonl | node -e 'process.stdin.on("data", d => console.log(String(d)))'`,
    `for n in 1 2; do sed -n "\${n}p" .agentic-wf/ledger.jsonl; done 2>&1 | head`,
    `grep -c "AC-1" app.test.mjs && echo "a > b" `,
  ];
  for (const command of cmds) assert.equal(hook(dir, { tool_name: 'Bash', tool_input: { command } }).code, 0, command);
});

test('writes hidden in scripts or quoted paths are still blocked', () => {
  const dir = makeProject();
  driveTo(dir, 'red');
  const cmds = [
    `node -e "require('fs').appendFileSync('.agentic-wf/ledger.jsonl', 'x')"`,
    `cat x > ".agentic-wf/ledger.jsonl"`,
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
  assert.equal(as('agentic-wf:code-reviewer', 'app.mjs'), 2);
  assert.equal(as('agentic-wf:code-reviewer', path.join(fd, 'review.draft.json')), 0);
  assert.equal(as('agentic-wf:evidence-auditor', path.join(fd, 'review.draft.json')), 2);
  assert.equal(as('agentic-wf:implementer', 'app.mjs'), 0);
});

test('does nothing outside an agentic-wf project', () => {
  const r = sh(process.execPath, [GUARD], path.parse(process.cwd()).root, JSON.stringify({ cwd: path.parse(process.cwd()).root, tool_name: 'Write', tool_input: { file_path: 'x' } }));
  assert.equal(r.code, 0);
});
