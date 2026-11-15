import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tnt, write, read, sh, makeProject, featureDir, PLUGIN, SPEC, TEST_FILE, APP } from './helpers.mjs';
import { excerptLog } from '../plugins/think-and-type/scripts/lib/harness.mjs';
import { summarizeTranscript } from '../plugins/think-and-type/scripts/lib/usage.mjs';

const must = (r) => { if (r.code !== 0) throw new Error(r.out); return r; };

test('the light profile: no Expect needed, no review/functional/auditor, verify alone closes it', () => {
  const dir = makeProject();
  must(tnt(dir, 'new', 'Add numbers', '--id', 'F-001'));
  const fd = featureDir(dir);
  write(dir, path.join(fd, 'spec.md'), SPEC.replace(' Expect: `sum=5`', ''));
  assert.match(tnt(dir, 'approve', 'F-001', '--by', 'T').out, /has no expected outcome/, 'the full profile still needs Expect');
  must(tnt(dir, 'approve', 'F-001', '--by', 'T', '--profile', 'light'));
  assert.equal(JSON.parse(tnt(dir, 'status', 'F-001', '--json').stdout).profile, 'light');
  must(tnt(dir, 'start', 'F-001'));
  write(dir, 'app.test.mjs', TEST_FILE);
  must(tnt(dir, 'lock-tests', 'F-001', 'app.test.mjs'));
  must(tnt(dir, 'run', 'F-001', 'red'));
  must(tnt(dir, 'gate', 'F-001', 'red'));
  write(dir, 'app.mjs', APP);
  must(tnt(dir, 'run', 'F-001', 'green'));
  must(tnt(dir, 'gate', 'F-001', 'green'));
  must(tnt(dir, 'run', 'F-001', 'style'));
  must(tnt(dir, 'gate', 'F-001', 'style'));
  assert.equal(JSON.parse(tnt(dir, 'status', 'F-001', '--json').stdout).nextGate, 'audit');
  assert.match(tnt(dir, 'gate', 'F-001', 'review').out, /not part of F-001's light profile/);
  assert.match(tnt(dir, 'gate', 'F-001', 'audit').out, /no `tnt verify` recorded/);
  must(tnt(dir, 'verify', 'F-001'));
  must(tnt(dir, 'gate', 'F-001', 'audit'));
  assert.equal(JSON.parse(tnt(dir, 'status', 'F-001', '--json').stdout).phase, 'done');
  assert.match(read(dir, path.join(fd, 'report.md')), /Profile: \*\*light\*\*/);
  assert.equal(must(tnt(dir, 'verify', '--integrated')).code, 0, 'integrated verify needs no functional evidence for light features');
  assert.ok(read(dir, path.join(fd, 'ledger.jsonl')).includes('"profile":"light"'), 'the choice is recorded with the approval');
});

test('a failing gate prints the failing lines of the run it cites', () => {
  const dir = makeProject();
  must(tnt(dir, 'new', 'Add numbers', '--id', 'F-001'));
  write(dir, path.join(featureDir(dir), 'spec.md'), SPEC);
  must(tnt(dir, 'approve', 'F-001', '--by', 'T'));
  must(tnt(dir, 'start', 'F-001'));
  write(dir, 'app.test.mjs', TEST_FILE);
  must(tnt(dir, 'lock-tests', 'F-001', 'app.test.mjs'));
  must(tnt(dir, 'run', 'F-001', 'red'));
  must(tnt(dir, 'gate', 'F-001', 'red'));
  write(dir, 'app.mjs', 'export const add = (a, b) => a - b;\n');
  must(tnt(dir, 'run', 'F-001', 'green'));
  const g = tnt(dir, 'gate', 'F-001', 'green');
  assert.equal(g.code, 1);
  assert.match(g.out, /failing output of #\d+ \(full log: .*green.*\.log\):\n  \| /);
  assert.match(g.out, /\| .*AC-1: add returns the sum/);
  assert.match(g.out, /\| .*-1 !== 5/);
});

test('excerpts keep failure lines with context and fall back to the tail', () => {
  const noise = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  const log = ['$ cmd', '# exit: 1', '---- stdout ----', ...noise.slice(0, 100), 'AssertionError: expected 1 to equal 2', ...noise.slice(100), '---- stderr ----', ''].join('\n');
  const ex = excerptLog(log);
  assert.ok(ex.includes('AssertionError: expected 1 to equal 2'));
  assert.ok(ex.length < 15);
  assert.ok(!ex.some((l) => l.startsWith('$ cmd')), 'the header with the command is not part of the excerpt');
  const quiet = excerptLog(['$ cmd', '---- stdout ----', ...noise, '---- stderr ----', ''].join('\n'));
  assert.equal(quiet[quiet.length - 1], 'line 199');
  assert.ok(quiet.length <= 25);
});

test('usage: transcripts are summed once per message and reported per feature and agent', () => {
  const msg = (id, model, u) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:0' + id + 'Z', message: { id: 'm' + id, model, usage: u } });
  const transcript = [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z' }),
    msg(1, 'claude-sonnet-5-5', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 }),
    msg(1, 'claude-sonnet-5-5', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 }), // streamed chunk, same message
    msg(2, 'claude-sonnet-5-5', { input_tokens: 5, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 30 }),
  ].join('\n');
  const s = summarizeTranscript(transcript);
  assert.deepEqual([s.requests, s.input, s.cacheWrite, s.cacheRead, s.output], [2, 15, 1200, 1000, 80]);
  assert.equal(s.durationMs, 2000);

  const dir = makeProject();
  const tpath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tnt-tr-')), 'agent.jsonl');
  fs.writeFileSync(tpath, transcript);
  const hook = path.join(PLUGIN, 'scripts', 'hooks', 'usage.mjs');
  const stop = (agent, feature) => sh(process.execPath, [hook], dir, JSON.stringify({
    cwd: dir, agent_type: agent, agent_id: 'a1', agent_transcript_path: tpath, last_assistant_message: `STEP: x\nFEATURE: ${feature}\nRESULT: done`,
  }));
  assert.equal(stop('tnt:implementer', 'F-001').code, 0);
  assert.equal(stop('tnt:implementer', 'F-001').code, 0);
  assert.equal(stop('tnt:code-reviewer', 'F-001').code, 0);
  assert.equal(stop('Explore', 'F-001').code, 0, 'other agents are ignored');
  const r = JSON.parse(must(tnt(dir, 'usage', '--json')).stdout);
  assert.equal(r.total.runs, 3);
  const f = r.features.find((x) => x.key === 'F-001');
  assert.equal(f.agents.find((a) => a.key === 'implementer').runs, 2);
  assert.equal(f.output, 240);
  assert.match(must(tnt(dir, 'usage')).out, /implementer\s+2/);
  assert.ok(read(dir, '.tnt/.gitignore').includes('usage.jsonl'));
});
