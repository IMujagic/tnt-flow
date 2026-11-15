#!/usr/bin/env node
// Copies the shared harness protocol into every agent's own instructions, keeping
// only the sections tagged for that agent. An agent's instructions are part of its
// cached system prompt, while a file it reads is new input on every spawn, so the
// copy is cheaper than "first read harness-protocol.md" and a step needs no extra
// tool call to start.
//
// Source: plugins/think-and-type/reference/harness-protocol.md. Each "##" or "###"
// section carries a `<!-- roles: a, b -->` (or `all`) comment on the line after its
// heading. `npm run build:agents` rewrites the generated block at the end of each
// agents/*.md; `--check` exits 1 if any block is stale (tests/agents.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN = path.resolve(here, '..', 'plugins', 'think-and-type');
const SOURCE = path.join(PLUGIN, 'reference', 'harness-protocol.md');
const AGENTS = path.join(PLUGIN, 'agents');
const BEGIN = '<!-- tnt:protocol begin: generated from reference/harness-protocol.md by `npm run build:agents`; edit the source, not this block -->';
const END = '<!-- tnt:protocol end -->';
const READ_IT = /`\$\{CLAUDE_PLUGIN_ROOT\}\/reference\/harness-protocol\.md`/g;

// Splits the protocol into sections with the roles that need them.
export function parseProtocol(text) {
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) {
      current = { level: h[1].length, title: h[2], roles: null, body: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const r = line.match(/^<!--\s*roles:\s*(.*?)\s*-->$/);
    if (r && current.roles === null) { current.roles = r[1].split(/\s*,\s*/).filter(Boolean); continue; }
    current.body.push(line);
  }
  for (const s of sections) if (!s.roles) throw new Error(`protocol section "${s.title}" has no <!-- roles: ... --> line`);
  return sections;
}

export function protocolFor(agent, sections) {
  const keep = sections.filter((s) => s.roles.includes('all') || s.roles.includes(agent));
  const body = keep.map((s) => `${'#'.repeat(s.level + 1)} ${s.title}\n${s.body.join('\n').replace(/\s+$/, '')}`).join('\n\n');
  return `${BEGIN}\n## Harness protocol\n\nThese rules apply to every step and override habits.\n\n${body}\n${END}\n`;
}

// The agent file with its generated block replaced (or appended) and any
// instruction to go and read the protocol file pointed at the block instead.
export function buildAgent(text, agent, sections) {
  const start = text.indexOf(BEGIN);
  const base = (start >= 0 ? text.slice(0, start) : text).replace(/\s+$/, '') + '\n\n';
  return base.replace(READ_IT, 'the harness protocol at the end of these instructions') + protocolFor(agent, sections);
}

export function buildAll({ check = false } = {}) {
  const sections = parseProtocol(fs.readFileSync(SOURCE, 'utf8'));
  const stale = [];
  for (const file of fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort()) {
    const p = path.join(AGENTS, file);
    const text = fs.readFileSync(p, 'utf8');
    const name = text.match(/^name:\s*(\S+)/m)?.[1] ?? path.basename(file, '.md');
    const next = buildAgent(text, name, sections);
    if (next !== text) {
      stale.push(file);
      if (!check) fs.writeFileSync(p, next);
    }
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = buildAll({ check });
  if (check && stale.length) { console.error(`stale protocol blocks: ${stale.join(', ')} (run npm run build:agents)`); process.exit(1); }
  console.log(check ? 'agent protocol blocks are up to date' : stale.length ? `updated ${stale.join(', ')}` : 'nothing to update');
}
