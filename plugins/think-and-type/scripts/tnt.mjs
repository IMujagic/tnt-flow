#!/usr/bin/env node
// tnt: the think-and-type harness CLI. Every claim a workflow step makes must be
// backed by something this tool recorded. Run `tnt help` for usage.
import { TntError, requireRoot, GATES, PROJECT_FEATURE, loadConfig, verifyLedger, resolveFeature } from './lib/core.mjs';
import * as h from './lib/harness.mjs';

const USAGE = `tnt - think-and-type evidence harness

Project
  tnt init [--type existing|greenfield] [--force]   create .tnt/ (requires a git repo)
  tnt config check                                  validate configured commands
  tnt baseline                                      record test + style commands on the current tree
  tnt ledger verify                                 check hash chain and evidence files

Features
  tnt new "<title>"                                 create F-NNN with a spec.md template
  tnt approve <F> --by "<human>"                    record human approval of spec.md, pass the spec gate
  tnt start <F>                                     record base commit, create branch, mark active
  tnt lock-tests <F> <file>... [--replace]          freeze test files (before the red gate)
  tnt unlock <F> --reason "<why>"                   reopen tests; resets red and every later gate

Evidence
  tnt run <F> red|green                             run commands.test, record output
  tnt run <F> style [--name lint]                   run style commands (all in config.style by default)
  tnt run <F> functional --ac AC-1 --expect "<regex>" [--artifact <file>]... -- <command>
  tnt run <F>|_project probe -- <command>           record any command (not gate-bearing)
  tnt review submit <F> <review.json>               validate and record a code review
  tnt audit submit <F> <audit.json>                 validate and record an audit report
  tnt verify <F>                                    re-run tests, style and functional evidence from scratch

Gates (${GATES.join(' > ')})
  tnt check <F> <gate>                              dry-run a gate: no ledger entry, commit or attempt (for subagents)
  tnt gate <F> <gate>                               decide a gate from recorded evidence (orchestrator only; exit 1 = fail)
  tnt waive <F> <gate> --reason "<why>" --by "<human>"   human-only escape hatch, flagged in reports

Reporting
  tnt status [<F>] [--json]                         features and gate state
  tnt report <F>                                    write features/<F>/report.md

Global: --json for machine-readable output.`;

function parse(argv) {
  const pos = []; const flags = {}; let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['json', 'force', 'replace'].includes(key)) { flags[key] = true; continue; }
      const val = argv[++i];
      if (val === undefined) throw new TntError(`--${key} needs a value`);
      if (key === 'artifact') (flags.artifact ??= []).push(val); else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags, rest };
}

const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);

function out(flags, data, text) {
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else console.log(typeof text === 'function' ? text(data) : text ?? JSON.stringify(data, null, 2));
}

const runLine = (r) => `#${r.seq} ${r.step}${r.name ? ':' + r.name : ''}${r.ac ? ' ' + r.ac : ''} exit=${r.exit}${r.timedOut ? ' TIMEOUT' : ''}${r.mutated ? ' MUTATED-TREE' : ''}${r.expect ? ` expect=${r.expectMatched ? 'matched' : 'NOT-matched'}` : ''}  log=${r.log}`;

function gateText(r) {
  const head = `gate ${r.gate} for ${r.feature}: ${r.pass ? 'PASS' : 'FAIL'} (ledger #${r.seq}, phase=${r.phase})`;
  const commit = r.commit?.sha ? `\ncommitted ${r.commit.sha.slice(0, 10)}` : r.commit?.error ? `\nWARNING: auto-commit failed: ${r.commit.error}` : '';
  if (r.pass) return head + commit;
  const limit = r.attempts >= r.maxIterations ? `\nattempt ${r.attempts}/${r.maxIterations}: iteration limit reached, escalate to the human` : `\nattempt ${r.attempts}/${r.maxIterations}`;
  return `${head}\n${r.reasons.map((x) => '  - ' + x).join('\n')}${limit}`;
}

function main(argv) {
  const { pos, flags, rest } = parse(argv);
  const [cmd, ...args] = pos;
  if (!cmd || cmd === 'help' || flags.help) { console.log(USAGE); return 0; }

  if (cmd === 'init') {
    const r = h.init(process.cwd(), { type: flags.type, force: flags.force });
    out(flags, r, `initialized ${r.root}/.tnt (type=${r.config.project.type}). Next: fill commands in .tnt/config.json, then \`tnt config check\` and \`tnt baseline\`.`);
    return 0;
  }

  const root = requireRoot();
  switch (cmd) {
    case 'config': {
      if (args[0] !== 'check') throw new TntError('usage: tnt config check');
      const r = h.configCheck(root);
      out(flags, r, () => (r.ok ? 'config OK\n' : 'config problems:\n' + r.problems.map((p) => '  - ' + p).join('\n') + '\n') + JSON.stringify({ commands: r.config.commands, style: r.config.style }, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'baseline': {
      const r = h.baseline(root);
      out(flags, r, () => [...r.runs.map(runLine), ...r.configProblems.map((p) => 'config: ' + p)].join('\n'));
      return r.runs.every((x) => x.exit === 0 && !x.mutated) ? 0 : 1;
    }
    case 'ledger': {
      const r = verifyLedger(root);
      out(flags, r, () => (r.ok ? `ledger intact (${r.count} entries)` : 'LEDGER BROKEN:\n' + r.errors.map((e) => '  - ' + e).join('\n')));
      return r.ok ? 0 : 1;
    }
    case 'new': {
      const r = h.newFeature(root, args.join(' '));
      out(flags, r, `created ${r.id}: edit ${r.dir}/spec.md`);
      return 0;
    }
    case 'approve': { const r = h.approve(root, args[0], { by: flags.by }); out(flags, r, gateText); return r.pass ? 0 : 1; }
    case 'start': { const r = h.start(root, args[0]); out(flags, r, `${r.feature} started${r.alreadyStarted ? ' (already)' : ''}; branch=${r.branch ?? '—'} base=${r.base || '(root)'}`); return 0; }
    case 'lock-tests': {
      const r = h.lockTests(root, args[0], args.slice(1), { replace: flags.replace });
      out(flags, r, `locked (ledger #${r.seq}):\n${Object.keys(r.files).map((x) => '  ' + x).join('\n')}`);
      return 0;
    }
    case 'unlock': { const r = h.unlock(root, args[0], { reason: flags.reason }); out(flags, r, `${r.id}: tests unlocked; red and later gates reset`); return 0; }
    case 'run': {
      const [ref, step] = args;
      const f = ref === PROJECT_FEATURE ? { id: PROJECT_FEATURE, dir: null } : resolveFeature(root, ref);
      if (f.dir === null && step !== 'probe') throw new TntError(`${PROJECT_FEATURE} only accepts probe runs; use \`tnt baseline\` to record the configured test and style commands`);
      const config = loadConfig(root);
      // `-- "<full command string>"` is used verbatim; several words are re-quoted for the shell.
      const userCmd = rest?.length === 1 ? rest[0] : rest?.length ? rest.map(quote).join(' ') : flags.cmd;
      let runs;
      if (step === 'red' || step === 'green') {
        if (userCmd) throw new TntError(`${step} always runs commands.test (the full suite); do not pass a command`);
        if (!config.commands.test) throw new TntError('commands.test is not configured');
        runs = [h.execRecorded(root, { feature: f.id, featureDir: f.dir, step, cmd: config.commands.test })];
      } else if (step === 'style') {
        if (userCmd) throw new TntError('style runs configured commands only; use --name to pick one');
        const names = flags.name ? [flags.name] : config.style;
        if (!names.length) throw new TntError('config.style is empty');
        runs = names.map((n) => {
          if (!config.commands[n]) throw new TntError(`commands.${n} is not configured`);
          return h.execRecorded(root, { feature: f.id, featureDir: f.dir, step, name: n, cmd: config.commands[n] });
        });
      } else if (step === 'functional') {
        if (!flags.ac || !flags.expect || !userCmd) throw new TntError('functional needs --ac AC-n, --expect "<regex>" and -- <command>');
        runs = [h.execRecorded(root, { feature: f.id, featureDir: f.dir, step, ac: flags.ac, cmd: userCmd, expect: flags.expect, artifacts: flags.artifact })];
      } else if (step === 'probe') {
        if (!userCmd) throw new TntError('probe needs -- <command>');
        runs = [h.execRecorded(root, { feature: f.id, featureDir: f.dir, step, cmd: userCmd, expect: flags.expect, artifacts: flags.artifact })];
      } else throw new TntError('step must be red, green, style, functional or probe');
      out(flags, runs, () => runs.map(runLine).join('\n'));
      return 0; // recording succeeded; pass/fail is judged by `tnt gate`
    }
    case 'gate': { const r = h.gate(root, args[0], args[1]); out(flags, r, gateText); return r.pass ? 0 : 1; }
    case 'check': {
      const r = h.check(root, args[0], args[1]);
      out(flags, r, () => `check ${r.gate} for ${r.feature}: ${r.pass ? 'PASS' : 'FAIL'} (dry run, nothing recorded)${r.reasons.map((x) => '\n  - ' + x).join('')}`);
      return r.pass ? 0 : 1;
    }
    case 'waive': { const r = h.waive(root, args[0], args[1], { reason: flags.reason, by: flags.by }); out(flags, r, `${args[1]} WAIVED for ${r.id} by ${flags.by}`); return 0; }
    case 'review':
    case 'audit': {
      if (args[0] !== 'submit') throw new TntError(`usage: tnt ${cmd} submit <F> <file.json>`);
      const r = cmd === 'review' ? h.submitReview(root, args[1], args[2]) : h.submitAudit(root, args[1], args[2]);
      out(flags, r, `${cmd} recorded (ledger #${r.seq}): verdict=${r.verdict}, saved ${r.file}`);
      return 0;
    }
    case 'verify': {
      const r = h.verify(root, args[0]);
      out(flags, r, () => (r.ok ? `verify PASS (ledger #${r.seq}; re-runs ${r.reruns.map((s) => '#' + s).join(' ')})` : `verify FAIL (ledger #${r.seq}):\n${r.failures.map((x) => '  - ' + x).join('\n')}`));
      return r.ok ? 0 : 1;
    }
    case 'status': {
      const r = h.status(root, args[0]);
      out(flags, r, () => (args[0]
        ? `${r.id} ${r.title}\n  phase: ${r.phase}  next gate: ${r.nextGate ?? '—'}  started: ${r.started}  branch: ${r.branch ?? '—'}\n  ACs: ${r.acs.join(', ') || '—'}\n  locked tests: ${r.lockedTests.join(', ') || '—'}\n  passed: ${Object.entries(r.gates).map(([g, s]) => `${g}#${s.seq}${s.waived ? '(WAIVED)' : ''}`).join(' ') || '—'}\n  attempts: ${JSON.stringify(r.attempts)}`
        : `${r.project.name} (${r.project.type})  active: ${r.active ?? '—'}\n${r.features.map((x) => `  ${x.id}  ${x.phase.padEnd(10)} ${x.title}${x.waivers ? '  [waivers]' : ''}`).join('\n') || '  no features yet'}`));
      return 0;
    }
    case 'report': { const p = h.writeReport(root, args[0]); out(flags, { path: p }, `wrote ${p}`); return 0; }
    default:
      throw new TntError(`unknown command "${cmd}". Run \`tnt help\`.`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof TntError) { console.error(`tnt: ${e.message}`); process.exitCode = 2; }
  else throw e;
}
