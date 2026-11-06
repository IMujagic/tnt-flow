#!/usr/bin/env node
// SessionStart: if the project uses agentic-wf, tell Claude where the
// harness CLI lives and what is in flight. Silent otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WF = '.agentic-wf';
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const cfg = path.join(projectDir, WF, 'config.json');
if (!fs.existsSync(cfg)) process.exit(0);

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'wf.mjs').replace(/\\/g, '/');
const lines = [`This project uses the agentic-wf harness. CLI: node "${cli}" <command> (\`help\` for usage).`];
try {
  const dir = path.join(projectDir, WF, 'features');
  const features = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^F-\d+/.test(d)).sort() : [];
  const active = fs.existsSync(path.join(projectDir, WF, 'active.json'))
    ? JSON.parse(fs.readFileSync(path.join(projectDir, WF, 'active.json'), 'utf8')).feature : null;
  const summary = features.map((d) => {
    const s = JSON.parse(fs.readFileSync(path.join(dir, d, 'state.json'), 'utf8'));
    return `${s.id} [${s.phase}] ${s.title}`;
  });
  if (active) lines.push(`Active feature: ${active}. Resume it with /agentic-wf:develop ${active}.`);
  if (summary.length) lines.push(`Features: ${summary.join('; ')}`);
  lines.push('Producers and verifiers run as separate subagents; do not edit code, tests or evidence from the main thread during /agentic-wf:develop.');
} catch { /* state unreadable: still announce the CLI */ }
process.stdout.write(lines.join('\n') + '\n');
