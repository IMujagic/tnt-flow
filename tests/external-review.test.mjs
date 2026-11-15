import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tnt, read, makeProject, driveTo, featureDir, ledgerOf } from './helpers.mjs';

// A stand-in for another vendor's reviewer: writes review JSON to $TNT_REVIEW_OUT.
const REVIEWER = `
const fs = require('fs');
const mode = process.argv[2];
if (mode === 'crash') process.exit(1);
const base = { summary: 'base=' + process.env.TNT_BASE + ' spec=' + fs.existsSync(process.env.TNT_SPEC), files_reviewed: ['app.mjs', 'app.test.mjs'] };
const review = {
  approve: { ...base, verdict: 'approve', findings: [] },
  invented: { ...base, verdict: 'approve', findings: [{ id: 'X1', severity: 'nit', file: 'app.mjs', line: 1, quote: 'function multiply', issue: 'made up' }] },
  changes: { ...base, verdict: 'changes_requested', findings: [{ id: 'X2', severity: 'major', file: 'app.mjs', line: 1, quote: 'export const add', issue: 'no input validation' }] },
}[mode];
fs.writeFileSync(process.env.TNT_REVIEW_OUT, JSON.stringify(review));
`;

function setup() {
  const dir = makeProject();
  driveTo(dir, 'review');
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tnt-ext-')), 'reviewer.cjs');
  fs.writeFileSync(script, REVIEWER);
  const use = (mode) => {
    const cfgPath = path.join(dir, '.tnt', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.commands.external_review = `node "${script.replace(/\\/g, '/')}" ${mode}`;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  };
  return { dir, use };
}

test('with external_review configured, the review gate needs an approving external review too', () => {
  const { dir, use } = setup();
  use('approve');
  const c = tnt(dir, 'check', 'F-001', 'review');
  assert.equal(c.code, 1);
  assert.match(c.out, /no external review recorded/);
  const r = tnt(dir, 'review', 'external', 'F-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /external review recorded .*verdict=approve/);
  assert.equal(tnt(dir, 'check', 'F-001', 'review').code, 0);
  const fd = featureDir(dir);
  const entry = ledgerOf(dir, fd).findLast((e) => e.type === 'review');
  assert.equal(entry.source, 'external');
  const saved = JSON.parse(read(dir, entry.file));
  const base = JSON.parse(tnt(dir, 'status', 'F-001', '--json').stdout).base;
  assert.equal(saved.summary, `base=${base} spec=true`);
  assert.ok(ledgerOf(dir, fd).some((e) => e.type === 'run' && e.seq === entry.run && e.step === 'review' && e.name === 'external'));
});

test('an external review with invented quotes is rejected like an agent review', () => {
  const { dir, use } = setup();
  use('invented');
  const r = tnt(dir, 'review', 'external', 'F-001');
  assert.equal(r.code, 2);
  assert.match(r.out, /external review rejected/);
  assert.match(r.out, /quote not found near app\.mjs:1/);
  assert.equal(tnt(dir, 'check', 'F-001', 'review').code, 1);
});

test('external changes_requested blocks the review gate even when the agent review approved', () => {
  const { dir, use } = setup();
  use('changes');
  assert.equal(tnt(dir, 'review', 'external', 'F-001').code, 0);
  const g = tnt(dir, 'gate', 'F-001', 'review');
  assert.equal(g.code, 1);
  assert.match(g.out, /external review #\d+ requested changes \(0 blocking, 1 major\)/);
});

test('a failing external review command is reported with its log and records nothing as a review', () => {
  const { dir, use } = setup();
  use('crash');
  const r = tnt(dir, 'review', 'external', 'F-001');
  assert.equal(r.code, 2);
  assert.match(r.out, /external review \(run #\d+, log .*\): exited 1/);
  assert.equal(ledgerOf(dir, featureDir(dir)).filter((e) => e.type === 'review' && e.source === 'external').length, 0);
});

test('review external without configuration is a usage error', () => {
  const dir = makeProject();
  driveTo(dir, 'review');
  const r = tnt(dir, 'review', 'external', 'F-001');
  assert.equal(r.code, 2);
  assert.match(r.out, /commands\.external_review is not configured/);
});
