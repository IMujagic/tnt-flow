#!/usr/bin/env node
// SubagentStop hook: records how many tokens each tnt subagent used, so
// `tnt usage` can show where a feature's cost goes. It appends one line to
// .tnt/usage.jsonl (local, git-ignored). Statistics only, never evidence, and it
// never blocks: any problem exits 0 silently.
import fs from 'node:fs';
import path from 'node:path';

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const agentType = String(input.agent_type || '');
  const transcript = input.agent_transcript_path;
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()) || findRoot(input.cwd || process.cwd());
  if (agentType.startsWith('tnt:') && root && transcript && fs.existsSync(transcript)) {
    const { summarizeTranscript } = await import('../lib/usage.mjs');
    const final = String(input.last_assistant_message || '');
    const entry = {
      ts: new Date().toISOString(), agent: agentType.replace(/^tnt:/, ''), agentId: input.agent_id,
      feature: final.match(/^\s*FEATURE:\s*((?:F|R)-[0-9A-Z]+)/im)?.[1] ?? activeFeature(root),
      result: final.match(/^\s*RESULT:\s*(\w+)/im)?.[1],
      ...summarizeTranscript(fs.readFileSync(transcript, 'utf8')),
    };
    fs.appendFileSync(path.join(root, '.tnt', 'usage.jsonl'), JSON.stringify(entry) + '\n');
  }
} catch { /* statistics only */ }
process.exit(0);

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.tnt', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function activeFeature(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.tnt', 'active.json'), 'utf8')).feature ?? null; } catch { return null; }
}
