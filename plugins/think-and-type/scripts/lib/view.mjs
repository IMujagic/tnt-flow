// `tnt view`: renders the ledgers as one self-contained HTML page (inline CSS,
// JS and data, no network) so a developer can read how a feature was built:
// every ledger entry in order, its log, gate reasons, review findings, human
// decisions, and the code diff wherever the recorded tree changes. The page is
// derived from the ledger and never feeds back into any gate.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TNT_DIR, GATES, PROJECT_FEATURE, git, head, treeHash, loadConfig, readJson, readLedger, verifyLedger,
  projectDir, listFeatures, resolveFeature, specPath, ensureLocalIgnores, relPath,
} from './core.mjs';

const LOG_LIMIT = 24000;
const PATCH_LIMIT = 80000;

function clip(text, limit, what) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - limit} characters of ${what} omitted …]\n\n${text.slice(-half)}`;
}

function readText(root, rel) {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function problemsBySeq(errors) {
  const out = {};
  for (const err of errors) {
    const m = /^entry (\d+): (.*)$/.exec(err);
    if (m) (out[m[1]] ??= []).push(m[2]);
  }
  return out;
}

// The base commit's tree without .tnt/, built the same way treeHash() builds
// recorded trees, so an unchanged checkout hashes to the same version.
function baseTree(root, base) {
  const tmp = path.join(os.tmpdir(), `tnt-view-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    if (git(root, ['read-tree', base], { env, allowFail: true }).status !== 0) return null;
    // -f: this throwaway index matches neither HEAD nor the working files; only the index is touched.
    git(root, ['rm', '-r', '-f', '--cached', '-q', '--ignore-unmatch', '--', TNT_DIR], { env });
    return git(root, ['write-tree'], { env }).stdout.trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const treeInStore = (root, tree) => git(root, ['cat-file', '-e', `${tree}^{tree}`], { allowFail: true }).status === 0;

function diffTrees(root, from, to) {
  const scope = ['--', '.', `:(exclude)${TNT_DIR}`];
  const counts = {};
  for (const line of git(root, ['diff', '--numstat', from, to, ...scope]).stdout.split(/\r?\n/)) {
    const [add, del, file] = line.split('\t');
    if (file) counts[file] = { add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) };
  }
  const files = git(root, ['diff', '--name-status', '-M', from, to, ...scope]).stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [status, a, b] = line.split('\t');
    const file = b ?? a;
    return { status: status[0], file, from: b ? a : undefined, ...(counts[file] ?? { add: null, del: null }) };
  });
  const patch = clip(git(root, ['diff', '-M', from, to, ...scope]).stdout, PATCH_LIMIT, 'diff');
  return { files, patch };
}

function collectScope(root, dir) {
  const ledger = readLedger(dir);
  const integrity = verifyLedger(root, dir);
  const problems = problemsBySeq(integrity.errors);
  const entries = ledger.map((e) => {
    const x = { ...e, problems: problems[e.seq] ?? [] };
    if (e.log) { const t = readText(root, e.log); x.logText = t === null ? null : clip(t, LOG_LIMIT, 'output'); }
    if (e.file && e.file.endsWith('.json')) { try { x.fileJson = readJson(path.join(root, e.file)); } catch { x.fileJson = null; } }
    return x;
  });
  return { entries, integrity: { ok: integrity.ok, errors: integrity.errors, count: integrity.count } };
}

function collectFeature(root, f) {
  const state = f.state;
  const { entries, integrity } = collectScope(root, f.dir);

  // Each distinct working tree the evidence was recorded on is one version of
  // the code. The base commit's tree is version 0, so the first diff shows
  // what the red step added.
  const versions = [];
  if (state.base) {
    const tree = baseTree(root, state.base);
    if (tree) versions.push({ tree, seq: null, label: 'base' });
  }
  for (const e of entries) {
    if (e.tree && (!versions.length || versions[versions.length - 1].tree !== e.tree)) versions.push({ tree: e.tree, seq: e.seq });
  }
  for (const v of versions) v.inStore = treeInStore(root, v.tree);
  const transitions = [];
  for (let i = 1; i < versions.length; i++) {
    const from = versions[i - 1], to = versions[i];
    const t = { from: from.tree, to: to.tree, atSeq: to.seq, version: i, inStore: from.inStore && to.inStore, files: [], patch: '' };
    if (t.inStore) Object.assign(t, diffTrees(root, from.tree, to.tree));
    transitions.push(t);
  }

  let spec = null;
  try { spec = fs.readFileSync(specPath(f.dir), 'utf8'); } catch { /* missing spec */ }
  return {
    id: f.id, title: state.title, dir: relPath(root, f.dir), phase: state.phase, created: state.created ?? null,
    branch: state.branch, baseBranch: state.baseBranch ?? null, base: state.base, syncedBase: state.syncedBase ?? null,
    approval: state.approval, gates: state.gates, attempts: state.attempts, waivers: state.waivers, unlocks: state.unlocks,
    lockedTests: state.locked ? Object.keys(state.locked.files) : [], spec,
    integrity, entries, versions, transitions,
  };
}

export function collectView(root, refs = []) {
  const config = loadConfig(root);
  const features = refs.length ? refs.map((r) => resolveFeature(root, r)) : listFeatures(root);
  return {
    generatedAt: new Date().toISOString(), project: config.project, head: head(root), tree: treeHash(root), gates: GATES,
    projectLedger: { id: PROJECT_FEATURE, ...collectScope(root, projectDir(root)) },
    features: features.map((f) => collectFeature(root, f)),
  };
}

export function writeView(root, { refs = [], out } = {}) {
  const data = collectView(root, refs);
  const dest = out ? path.resolve(out) : path.join(root, TNT_DIR, 'view.html');
  if (!out) ensureLocalIgnores(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, renderView(data));
  return { path: dest, features: data.features.map((f) => f.id) };
}

// JSON inside <script> must not contain "</script>" or line separators that
// end a JS string, so <, U+2028 and U+2029 become JSON unicode escapes
// (backslash, "u", four hex digits). That makes any command output safe to embed.
const UNSAFE = new RegExp("[<" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
const embed = (data) => JSON.stringify(data).replace(UNSAFE, (c) => String.fromCharCode(92) + "u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

export function renderView(data) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tnt ledger · ${String(data.project?.name || 'project').replace(/[<&>"]/g, '')}</title>
<style>${CSS}</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="tnt-data">${embed(data)}</script>
<script>${JS}</script>
</body>
</html>
`;
}

const CSS = `
:root { --bg:#F4F6F9; --surface:#FFFFFF; --ink:#141B2B; --muted:#5A6479; --line:#DCE1E9; --accent:#1F4FD1; --accent-soft:#E3EAFC;
  --pass:#12765A; --pass-soft:#DCF1E7; --fail:#B3361C; --fail-soft:#FBE5DE; --human:#7344BC; --human-soft:#EEE6FA; --code:#EEF1F6;
  --add:#E3F4EA; --add-ink:#11613F; --del:#FBE7E2; --del-ink:#9A2E17;
  --v0:#6B7280; --v1:#1F4FD1; --v2:#0E7C86; --v3:#B45309; --v4:#7344BC; --v5:#BE185D; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#0D121B; --surface:#151C28; --ink:#E5E9F1; --muted:#98A2B5; --line:#283244; --accent:#86A8FF; --accent-soft:#1B2949;
  --pass:#55C998; --pass-soft:#12312A; --fail:#F0886C; --fail-soft:#3A1E17; --human:#BE9EF7; --human-soft:#2A2143; --code:#1B2333;
  --add:#132D22; --add-ink:#7FD9AE; --del:#3A1D18; --del-ink:#F3A08A;
  --v0:#9CA3AF; --v1:#86A8FF; --v2:#4FC7CF; --v3:#F2A65A; --v4:#BE9EF7; --v5:#F472B6; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, "Segoe UI", -apple-system, sans-serif; }
code, pre, .mono { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 0.86em; }
header.top { background: var(--surface); border-bottom: 1px solid var(--line); padding: 16px max(16px, env(safe-area-inset-left)); display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; }
header.top h1 { font-size: 1.15rem; margin: 0; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 20px max(16px, env(safe-area-inset-left)); max-width: 1280px; margin: 0 auto; }
@media (min-width: 960px) { .layout { grid-template-columns: 280px minmax(0, 1fr); } }
nav { display: grid; gap: 8px; align-content: start; }
nav button { all: unset; cursor: pointer; display: grid; gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
nav button[aria-current="true"] { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
nav button:focus-visible, summary:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.muted { color: var(--muted); }
.small { font-size: 0.82rem; }
.gatebar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
.gatebar span { height: 6px; border-radius: 3px; background: var(--line); }
.gatebar span.pass { background: var(--pass); } .gatebar span.waived { background: var(--human); }
.gatebar.big span { height: auto; padding: 6px 4px; font-size: 0.75rem; text-align: center; color: var(--muted); background: var(--surface); border: 1px solid var(--line); }
.gatebar.big span.pass { background: var(--pass-soft); color: var(--pass); border-color: transparent; font-weight: 600; }
.gatebar.big span.waived { background: var(--human-soft); color: var(--human); border-color: transparent; font-weight: 600; }
main { display: grid; gap: 16px; min-width: 0; align-content: start; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px; min-width: 0; }
.title h2 { margin: 0 0 4px; font-size: 1.35rem; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 0.88rem; }
.alert { border-radius: 8px; padding: 10px 14px; font-weight: 500; }
.alert.bad { background: var(--fail-soft); color: var(--fail); }
.alert.ok { background: var(--pass-soft); color: var(--pass); }
.pill { display: inline-block; font: 600 0.72rem/1 ui-monospace, Consolas, monospace; padding: 4px 7px; border-radius: 99px; white-space: nowrap; }
.pill.pass { background: var(--pass-soft); color: var(--pass); } .pill.fail { background: var(--fail-soft); color: var(--fail); }
.pill.human { background: var(--human-soft); color: var(--human); } .pill.info { background: var(--accent-soft); color: var(--accent); }
.versions { display: flex; flex-wrap: wrap; gap: 8px; }
.ver { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--line); border-radius: 99px; padding: 4px 10px 4px 6px; font-size: 0.82rem; background: var(--surface); }
.dot { width: 12px; height: 12px; border-radius: 50%; flex: none; background: var(--c, var(--v0)); }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
ol.timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.row { display: grid; grid-template-columns: 54px 16px minmax(0, 1fr); gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.row .seq { font: 600 0.85rem ui-monospace, Consolas, monospace; color: var(--muted); padding-top: 2px; }
.row .dot { margin-top: 5px; }
.row .body { display: grid; gap: 4px; min-width: 0; }
.row .head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.row .head b { font-weight: 600; }
.row.human { background: linear-gradient(90deg, var(--human-soft), transparent 60%); }
.row.broken { background: var(--fail-soft); }
.change { margin: 6px 0; padding: 12px 14px; border: 1px dashed var(--line); border-radius: 8px; display: grid; gap: 8px; background: var(--bg); }
.change .files { display: grid; gap: 2px; font-size: 0.85rem; }
.change .files div { display: flex; gap: 10px; flex-wrap: wrap; }
.st { font: 600 0.75rem ui-monospace, Consolas, monospace; width: 1.4em; }
.st.A { color: var(--add-ink); } .st.D { color: var(--del-ink); } .st.M, .st.R { color: var(--accent); }
.n-add { color: var(--add-ink); } .n-del { color: var(--del-ink); }
details > summary { cursor: pointer; color: var(--accent); font-size: 0.85rem; width: fit-content; }
pre { margin: 6px 0 0; background: var(--code); border-radius: 6px; padding: 10px 12px; overflow-x: auto; white-space: pre; max-height: 460px; line-height: 1.45; }
pre.diff span { display: block; } pre.diff .a { background: var(--add); color: var(--add-ink); } pre.diff .d { background: var(--del); color: var(--del-ink); } pre.diff .h { color: var(--accent); } pre.diff .f { font-weight: 700; }
ul.plain { margin: 4px 0 0; padding-left: 18px; }
.finding { border-left: 3px solid var(--line); padding: 4px 10px; margin-top: 6px; }
.finding.blocking, .finding.major { border-color: var(--fail); } .finding.minor { border-color: var(--accent); }
.problem { color: var(--fail); font-weight: 600; font-size: 0.85rem; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const JS = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('tnt-data').textContent);
  var app = document.getElementById('app');
  var HUMAN = { approve: 1, unlock: 1, waive: 1 };

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] == null || attrs[k] === false) return;
      if (k === 'class') el.className = attrs[k]; else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'style') el.setAttribute('style', attrs[k]); else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c == null || c === false) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function short(x) { return x ? String(x).slice(0, 10) : '—'; }
  function time(ts) { try { var d = new Date(ts); return d.toLocaleString(); } catch (e) { return ts; } }
  function pill(text, kind) { return h('span', { class: 'pill ' + kind, text: text }); }
  function pre(text) { return h('pre', { text: text }); }
  function more(label, content) { return h('details', null, [h('summary', { text: label }), content]); }

  function versionColor(f) {
    var map = {};
    f.versions.forEach(function (v, i) { map[v.tree] = i === 0 && v.label === 'base' ? 'var(--v0)' : 'var(--v' + (1 + ((i - (f.versions[0] && f.versions[0].label === 'base' ? 1 : 0)) % 5)) + ')'; });
    return function (tree) { return map[tree] || 'var(--line)'; };
  }

  function diffPre(patch) {
    var el = h('pre', { class: 'diff' });
    patch.split('\n').forEach(function (line) {
      var c = line.indexOf('+++') === 0 || line.indexOf('---') === 0 || line.indexOf('diff --git') === 0 ? 'f'
        : line[0] === '+' ? 'a' : line[0] === '-' ? 'd' : line.indexOf('@@') === 0 ? 'h' : '';
      el.appendChild(h('span', { class: c, text: line || ' ' }));
    });
    return el;
  }

  function changeBlock(t, color) {
    var box = h('div', { class: 'change' }, [
      h('div', { class: 'head' }, [h('span', { class: 'dot', style: '--c:' + color(t.to) }),
        h('b', { text: 'Code changed: version ' + t.version + ' ' }), h('span', { class: 'muted mono small', text: short(t.from) + ' → ' + short(t.to) })])
    ]);
    if (!t.inStore) { box.appendChild(h('div', { class: 'muted small', text: 'One of these code versions is no longer in the git object store (unreferenced trees are pruned by git gc), so the diff cannot be shown.' })); return box; }
    if (!t.files.length) { box.appendChild(h('div', { class: 'muted small', text: 'Only files excluded from the evidence changed.' })); return box; }
    box.appendChild(h('div', { class: 'files' }, t.files.map(function (x) {
      return h('div', null, [h('span', { class: 'st ' + x.status, text: x.status }), h('code', { text: x.from ? x.from + ' → ' + x.file : x.file }),
        x.add != null ? h('span', { class: 'n-add mono small', text: '+' + x.add }) : null, x.del != null ? h('span', { class: 'n-del mono small', text: '−' + x.del }) : null]);
    })));
    box.appendChild(more('Show diff', diffPre(t.patch)));
    return box;
  }

  function describe(e) {
    var d = { title: e.type, kind: 'info', status: null, extra: [] };
    switch (e.type) {
      case 'init': d.title = 'Harness initialised (' + (e.projectType || '') + ')'; break;
      case 'feature-created': d.title = 'Feature created: ' + e.title; break;
      case 'approve': d.title = 'Spec approved by ' + e.by; d.kind = 'human'; d.status = pill('human', 'human');
        d.extra.push(h('div', { class: 'small muted' }, ['Spec hash ', h('code', { text: short(e.specSha) }), ' · ACs: ' + (e.acs || []).join(', ')])); break;
      case 'start': d.title = 'Started' + (e.branch ? ' on ' + e.branch : '') ; d.extra.push(h('div', { class: 'small muted' }, ['Base commit ', h('code', { text: short(e.base) })])); break;
      case 'lock-tests': d.title = 'Locked ' + Object.keys(e.files || {}).length + ' test file(s)';
        d.extra.push(h('ul', { class: 'plain small' }, Object.keys(e.files || {}).map(function (k) { return h('li', null, [h('code', { text: k }), ' ', h('span', { class: 'muted mono', text: short(e.files[k]) })]); }))); break;
      case 'unlock': d.title = 'Tests unlocked: ' + e.reason; d.kind = 'human'; d.status = pill('human', 'human'); break;
      case 'waive': d.title = 'Gate ' + e.gate + ' waived by ' + e.by; d.kind = 'human'; d.status = pill('WAIVED', 'human'); d.extra.push(h('div', { class: 'small', text: 'Reason: ' + e.reason })); break;
      case 'run':
        d.title = e.step + (e.name ? ':' + e.name : '') + (e.ac ? ' ' + e.ac : '');
        d.status = pill('exit ' + e.exit + (e.timedOut ? ' timeout' : ''), e.exit === 0 && !e.timedOut ? 'pass' : (e.step === 'red' ? 'info' : 'fail'));
        d.extra.push(h('div', { class: 'small' }, [h('code', { text: e.cmd })]));
        var notes = [];
        if (e.expect) notes.push(h('span', null, ['expect ', h('code', { text: '/' + e.expect + '/' }), ' ', pill(e.expectMatched ? 'matched' : 'not matched', e.expectMatched ? 'pass' : 'fail')]));
        if (e.mutated) notes.push(pill('modified the working tree', 'fail'));
        notes.push(h('span', { class: 'muted', text: (e.durationMs / 1000).toFixed(1) + ' s' }));
        d.extra.push(h('div', { class: 'small head' }, notes));
        if (e.logText != null) d.extra.push(more('Show output', pre(e.logText)));
        else if (e.log) d.extra.push(h('div', { class: 'problem', text: 'Log file missing: ' + e.log }));
        break;
      case 'gate':
        d.title = 'Gate ' + e.gate; d.status = pill(e.pass ? 'PASS' : 'FAIL', e.pass ? 'pass' : 'fail');
        if (!e.pass && e.reasons) d.extra.push(h('ul', { class: 'plain small' }, e.reasons.map(function (r) { return h('li', { text: r }); })));
        break;
      case 'review':
        d.title = 'Code review: ' + e.verdict.replace('_', ' '); d.status = pill(e.verdict === 'approve' ? 'approve' : 'changes', e.verdict === 'approve' ? 'pass' : 'fail');
        d.extra.push(h('div', { class: 'small muted', text: ['blocking', 'major', 'minor', 'nit'].map(function (s) { return (e.counts[s] || 0) + ' ' + s; }).join(' · ') }));
        if (e.fileJson && e.fileJson.findings && e.fileJson.findings.length) d.extra.push(more('Show ' + e.fileJson.findings.length + ' finding(s)', h('div', null, e.fileJson.findings.map(function (x) {
          return h('div', { class: 'finding ' + x.severity }, [h('div', { class: 'small' }, [pill(x.severity, x.severity === 'blocking' || x.severity === 'major' ? 'fail' : 'info'), ' ', h('code', { text: x.file + ':' + x.line })]),
            h('div', { text: x.issue }), x.quote ? pre(x.quote) : null]);
        }))));
        break;
      case 'audit-report':
        d.title = 'Audit report: ' + e.verdict; d.status = pill(e.verdict, e.verdict === 'pass' ? 'pass' : 'fail');
        if (e.fileJson && e.fileJson.checks) d.extra.push(more('Show ' + e.fileJson.checks.length + ' check(s)', h('ul', { class: 'plain small' }, e.fileJson.checks.map(function (c) {
          return h('li', null, [pill(c.result, c.result === 'pass' ? 'pass' : 'fail'), ' ', c.name + ' ', h('span', { class: 'muted', text: '(' + c.evidence + ')' })]);
        }))));
        break;
      case 'verify':
        d.title = 'tnt verify re-ran ' + (e.reruns || []).length + ' command(s)'; d.status = pill(e.ok ? 'reproduced' : 'failed', e.ok ? 'pass' : 'fail');
        if (e.failures && e.failures.length) d.extra.push(h('ul', { class: 'plain small' }, e.failures.map(function (r) { return h('li', { text: r }); })));
        break;
      case 'sync':
        d.title = 'Base merged: synced onto ' + (e.ref || short(e.onto)); d.status = e.reset ? pill('gates reset', 'fail') : pill('code unchanged', 'info');
        if (e.relocked) { d.kind = 'human'; d.extra.push(h('div', { class: 'small' }, ['Re-locked ' + Object.keys(e.relocked).join(', ') + ' by ' + e.by + ': ' + e.reason])); }
        break;
    }
    return d;
  }

  function timeline(f, filter) {
    var color = versionColor(f);
    var bySeq = {}; f.transitions.forEach(function (t) { if (t.atSeq != null) bySeq[t.atSeq] = t; });
    var list = h('ol', { class: 'timeline' });
    f.entries.forEach(function (e) {
      var d = describe(e);
      var show = filter === 'all' || (filter === 'gates' && (e.type === 'gate' || e.type === 'waive')) || (filter === 'runs' && e.type === 'run')
        || (filter === 'human' && (d.kind === 'human')) || (filter === 'problems' && (e.problems.length || (e.type === 'gate' && !e.pass) || (e.type === 'run' && e.exit !== 0 && e.step !== 'red')));
      if (bySeq[e.seq] && (filter === 'all' || filter === 'code')) list.appendChild(h('li', null, [changeBlock(bySeq[e.seq], color)]));
      if (!show) return;
      var body = h('div', { class: 'body' }, [h('div', { class: 'head' }, [h('b', { text: d.title }), d.status, h('span', { class: 'muted small', text: time(e.ts) })])].concat(d.extra));
      e.problems.forEach(function (p) { body.appendChild(h('div', { class: 'problem', text: 'Integrity: ' + p })); });
      list.appendChild(h('li', { class: 'row' + (d.kind === 'human' ? ' human' : '') + (e.problems.length ? ' broken' : '') }, [
        h('span', { class: 'seq', text: '#' + e.seq }), h('span', { class: 'dot', title: e.tree ? 'code version ' + e.tree : 'no code version', style: '--c:' + (e.tree ? color(e.tree) : 'transparent') }), body]));
    });
    return list;
  }

  function gatebar(f, big) {
    return h('div', { class: 'gatebar' + (big ? ' big' : '') }, data.gates.map(function (g) {
      var s = f.gates && f.gates[g]; return h('span', { class: s ? (s.waived ? 'waived' : 'pass') : '', title: g, text: big ? g : null });
    }));
  }

  var current = null, filter = 'all';
  function renderFeature(f) {
    var main = h('main');
    main.appendChild(h('div', { class: 'card title' }, [
      h('h2', { text: f.id + ' · ' + f.title }),
      h('div', { class: 'meta muted' }, [h('span', { text: 'Phase: ' + f.phase }), f.branch ? h('span', null, ['Branch ', h('code', { text: f.branch })]) : null,
        f.approval ? h('span', { text: 'Spec approved by ' + f.approval.by }) : null, h('span', null, ['Ledger ', h('code', { text: f.dir + '/ledger.jsonl' })])]),
      h('div', { style: 'margin-top:12px' }, [gatebar(f, true)])
    ]));
    main.appendChild(f.integrity.ok ? h('div', { class: 'alert ok', text: 'Ledger intact: ' + f.integrity.count + ' entries, every hash, link and evidence file checks out.' })
      : h('div', { class: 'alert bad', text: 'Ledger BROKEN: ' + f.integrity.errors.join('; ') }));
    if (f.versions.length) main.appendChild(h('div', { class: 'card' }, [h('div', { class: 'small muted', style: 'margin-bottom:8px', text: 'Code versions the evidence was recorded on. Each colour is one working tree.' }),
      h('div', { class: 'versions' }, f.versions.map(function (v, i) {
        var c = versionColor(f)(v.tree);
        return h('span', { class: 'ver' }, [h('span', { class: 'dot', style: '--c:' + c }), v.label === 'base' ? 'base' : 'v' + i, h('span', { class: 'muted mono', text: short(v.tree) + (v.seq ? ' · from #' + v.seq : '') + (v.inStore ? '' : ' · pruned') })]);
      }))]));
    var sel = h('select', { id: 'filter', 'aria-label': 'Show', onchange: function (ev) { filter = ev.target.value; draw(); } },
      [['all', 'Everything'], ['code', 'Code changes'], ['gates', 'Gate decisions'], ['runs', 'Command runs'], ['human', 'Human decisions'], ['problems', 'Failures and problems']].map(function (o) {
        return h('option', { value: o[0], selected: o[0] === filter ? 'selected' : null, text: o[1] }); }));
    main.appendChild(h('div', { class: 'card' }, [h('div', { class: 'toolbar', style: 'margin-bottom:6px' }, [h('b', { text: 'Ledger timeline' }), sel]), timeline(f, filter)]));
    if (f.spec) main.appendChild(h('div', { class: 'card' }, [more('Show spec.md', pre(f.spec))]));
    return main;
  }

  function renderProject() {
    var p = data.projectLedger, main = h('main');
    main.appendChild(h('div', { class: 'card title' }, [h('h2', { text: 'Project events' }), h('div', { class: 'muted', text: 'init, baseline and project probes (.tnt/_project/ledger.jsonl)' })]));
    main.appendChild(p.integrity.ok ? h('div', { class: 'alert ok', text: 'Ledger intact: ' + p.integrity.count + ' entries.' }) : h('div', { class: 'alert bad', text: 'Ledger BROKEN: ' + p.integrity.errors.join('; ') }));
    main.appendChild(h('div', { class: 'card' }, [timeline({ entries: p.entries, versions: [], transitions: [] }, 'all')]));
    return main;
  }

  function draw() {
    var id = current;
    var nav = h('nav', { 'aria-label': 'Features' }, data.features.map(function (f) {
      return h('button', { 'aria-current': f.id === id ? 'true' : 'false', onclick: function () { current = f.id; location.hash = f.id; draw(); } }, [
        h('div', { class: 'head' }, [h('b', { text: f.id }), f.integrity.ok ? null : pill('broken', 'fail'), f.waivers.length ? pill('waived', 'human') : null]),
        h('div', { class: 'small', text: f.title }), gatebar(f), h('div', { class: 'small muted', text: f.phase })]);
    }).concat([h('button', { 'aria-current': id === '_project' ? 'true' : 'false', onclick: function () { current = '_project'; location.hash = '_project'; draw(); } }, [h('b', { text: 'Project events' }), h('div', { class: 'small muted', text: 'init and baseline' })])]));
    var f = data.features.filter(function (x) { return x.id === id; })[0];
    var top = h('header', { class: 'top' }, [h('h1', { text: 'tnt ledger · ' + (data.project.name || 'project') }),
      h('span', { class: 'muted small' }, ['Generated ' + time(data.generatedAt) + ' at ', h('code', { text: short(data.head) }), ' · current tree ', h('code', { text: short(data.tree) })])]);
    app.replaceChildren(top, h('div', { class: 'layout' }, [nav, f ? renderFeature(f) : renderProject()]));
  }

  var want = decodeURIComponent((location.hash || '').slice(1));
  current = data.features.some(function (f) { return f.id === want; }) || want === '_project' ? want : (data.features[0] ? data.features[0].id : '_project');
  draw();
})();
`;
