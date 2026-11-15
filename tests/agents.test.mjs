import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildAll, parseProtocol, protocolFor, PLUGIN } from '../tools/build-agents.mjs';

const agents = path.join(PLUGIN, 'agents');

test('every agent carries an up-to-date copy of the protocol sections for its role', () => {
  assert.deepEqual(buildAll({ check: true }), [], 'run `npm run build:agents`');
  for (const f of fs.readdirSync(agents)) {
    const text = fs.readFileSync(path.join(agents, f), 'utf8');
    assert.ok(text.includes('<!-- tnt:protocol begin'), `${f} has no protocol block`);
    assert.ok(!text.includes('reference/harness-protocol.md`'), `${f} still sends the agent to read the protocol file`);
  }
});

test('the protocol is filtered by role', () => {
  const sections = parseProtocol(fs.readFileSync(path.join(PLUGIN, 'reference', 'harness-protocol.md'), 'utf8'));
  const architect = protocolFor('architect', sections);
  const tester = protocolFor('functional-tester', sections);
  for (const block of [architect, tester]) {
    assert.match(block, /### 1\. Proof, not claims/);
    assert.match(block, /### 6\. Final message format/);
  }
  assert.doesNotMatch(architect, /Step boundaries|Traceability|Reviews of changes built outside tnt/);
  assert.match(tester, /#### Reviews of changes built outside tnt/);
  assert.match(tester, /### 5\. Evidence hygiene/);
  assert.ok(architect.length < tester.length);
});
