// Token usage per tnt subagent, recorded by hooks/usage.mjs (SubagentStop) into
// .tnt/usage.jsonl and reported by `tnt usage`. Local statistics, never evidence.
import fs from 'node:fs';
import path from 'node:path';
import { TNT_DIR } from './core.mjs';

export const usagePath = (root) => path.join(root, TNT_DIR, 'usage.jsonl');

// Sums a subagent transcript. Streamed chunks of one API message repeat its
// usage, so each message id counts once.
export function summarizeTranscript(text) {
  const byId = new Map();
  let first = null;
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.timestamp) { first ??= e.timestamp; last = e.timestamp; }
    const m = e.type === 'assistant' ? e.message : null;
    if (m?.usage) byId.set(m.id ?? `anon-${byId.size}`, { model: m.model, u: m.usage });
  }
  const sum = { requests: byId.size, models: [], input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const models = new Set();
  for (const { model, u } of byId.values()) {
    if (model) models.add(model);
    sum.input += u.input_tokens ?? 0;
    sum.cacheWrite += u.cache_creation_input_tokens ?? 0;
    sum.cacheRead += u.cache_read_input_tokens ?? 0;
    sum.output += u.output_tokens ?? 0;
  }
  sum.models = [...models];
  sum.durationMs = first && last ? Date.parse(last) - Date.parse(first) : null;
  return sum;
}

export function readUsage(root) {
  const p = usagePath(root);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const add = (a, e) => {
  a.runs += 1;
  for (const k of ['requests', 'input', 'cacheWrite', 'cacheRead', 'output']) a[k] += e[k] ?? 0;
  for (const m of e.models ?? []) if (!a.models.includes(m)) a.models.push(m);
  a.durationMs += e.durationMs ?? 0;
  return a;
};
const empty = (key) => ({ key, runs: 0, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, models: [], durationMs: 0 });

// Totals per feature and, within each, per agent. `refs` limits the report.
export function usageReport(root, refs = []) {
  const want = new Set(refs.map((r) => r.toUpperCase()));
  const entries = readUsage(root).filter((e) => !want.size || want.has(String(e.feature).toUpperCase()));
  const features = new Map();
  for (const e of entries) {
    const id = e.feature ?? '(unknown)';
    if (!features.has(id)) features.set(id, { ...empty(id), agents: new Map() });
    const f = features.get(id);
    add(f, e);
    if (!f.agents.has(e.agent)) f.agents.set(e.agent, empty(e.agent));
    add(f.agents.get(e.agent), e);
  }
  const total = entries.reduce(add, empty('total'));
  return {
    total,
    features: [...features.values()].map((f) => ({ ...f, agents: [...f.agents.values()].sort((a, b) => b.output + b.input + b.cacheWrite - (a.output + a.input + a.cacheWrite)) })),
  };
}

const k = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(n));
export function usageText(r) {
  if (!r.total.runs) return 'no usage recorded yet (.tnt/usage.jsonl fills as tnt subagents finish)';
  const row = (a, indent) => `${indent}${a.key.padEnd(20 - indent.length)} ${String(a.runs).padStart(4)}  ${k(a.input + a.cacheWrite).padStart(7)}  ${k(a.cacheRead).padStart(7)}  ${k(a.output).padStart(7)}  ${a.models.map((m) => m.replace(/^claude-/, '')).join(', ')}`;
  const lines = ['scope / agent        runs    input  cached   output  models', ...r.features.flatMap((f) => [row(f, ''), ...f.agents.map((a) => row(a, '  '))]), row(r.total, '')];
  lines.push('', 'input = uncached input + cache writes; cached = cache reads (billed at a fraction of input). Compare costs within one model; prices differ by model.');
  return lines.join('\n');
}
