# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The development workspace for **think-and-type**, a Claude Code plugin that runs an
evidence-gated, subagent-per-step development workflow: TDD red/green, style,
code review, functional testing and audit. The repo root is a local plugin
marketplace (`.claude-plugin/marketplace.json`), and the shippable plugin lives in
`plugins/think-and-type/`. Anything outside that directory (tests, this file, the README)
does not ship.

## Commands

```bash
npm test                                   # all harness tests (node:test, no deps)
node --test --test-name-pattern="red gate" "tests/*.test.mjs"   # single test by name
node --test tests/guard.test.mjs           # single file
npm run validate                           # claude plugin validate (plugin + marketplace)
claude --plugin-dir plugins/think-and-type     # load the plugin from source in a session
node plugins/think-and-type/scripts/tnt.mjs help
```

The tests build throwaway git repos in the OS temp dir and drive the real CLI with
a demo project whose suite is `node --test`. `tests/helpers.mjs` strips
`NODE_TEST_CONTEXT` so the nested `node --test` runs normally. Keep that if you add
spawning helpers. `driveTo(dir, '<gate>')` advances a demo feature through every
gate up to and including the named one; most tests start from it.

## Architecture

Two layers. They must stay in sync.

**1. Deterministic harness (`plugins/think-and-type/scripts/`, Node ≥18, zero deps)**: the source of truth for every gate decision.
- `lib/core.mjs`: primitives. `treeHash()` hashes the working-tree content through a temporary `GIT_INDEX_FILE`, honouring `.gitignore` and excluding `.tnt/`, so evidence is bound to code, not commits. Also the hash-chained ledgers (`appendLedger(dir, …)` and `verifyLedger(root, dir)`, using `stableStringify` for canonical hashing). There is **one chain per scope**: each feature dir has its own `ledger.jsonl`, and project events live in `.tnt/_project/` (`scopeDir()`). This keeps feature branches from conflicting on merge, so never reintroduce a shared, append-everything file. `requireRoot()` refuses the 0.1 single `.tnt/ledger.jsonl`. Feature ids are random (`FEATURE_ID`, Crockford base32) unless `tnt new --id`, and `active.json` is git-ignored through `.tnt/.gitignore` (`ensureLocalIgnores`). Also config defaults and merge, feature dirs, and the AC parser for `spec.md`. Specs always write ids as `AC-n`. `acRegex()` matches them in tests and logs in whatever style the language allows (`AC-1`, `test_ac_1`, `TestAC1`, `ac1_`), so the red gate works in stacks whose test names can't contain `-`. `tests/ac-id.test.mjs` covers both the matches and the near-misses (`AC-10`, `MAC1`).
- `lib/harness.mjs`: every state transition. `execRecorded()` runs a command, writes a log, and records tree before and after (`mutated` runs are rejected as evidence). `EVALUATORS` holds the per-gate rules. `gate()` applies preconditions (earlier gates passed, spec hash unchanged since approval, post-green gates on the green tree), then the evaluator; on pass it clears all later gates and auto-commits at red, green and audit. `submitReview()` checks that each finding's quote exists near file:line in the reviewed tree object, and that `files_reviewed` covers the diff. `verify()` re-executes the test, style and functional evidence on the green tree. `verifyIntegrated()` (`tnt verify --integrated`) re-proves every done feature on whatever tree is checked out, normally a PR merge commit in CI, and records nothing (`runCommand()` is the non-recording half of `execRecorded()`). `sync()` records a base branch merged into a feature branch: the review diff then starts at `syncedBase`, gates from green on reset if the tree changed, and changed locked tests need a human `--relock --by --reason`.
- `tnt.mjs`: thin CLI and argument parsing. Exit codes: 0 ok or pass, 1 gate or check failed, 2 usage error or `TntError`.
- Functional evidence is additive. `functionalRuns()` keeps the latest run **per distinct command** for each AC on a tree. All of them must pass, and `verify()` re-runs all of them, so an extra probe can't hide a spec case.
- `hooks/guard.mjs` (PreToolUse): a shell command counts as a write when it has a `>` outside quotes or uses a write-capable command or API. Quotes are stripped first, so `node -e "x => …"` reads aren't blocked. It blocks writes to CLI-owned paths, blocks edits to locked tests while the active feature's phase is red or later, and confines verifier agents (matched on `agent_type`) to their draft files. `hooks/session-start.mjs` injects the CLI path and the feature status.

The gate order is `GATES` in `core.mjs`: spec → red → green → style → review →
functional → audit. `state.phase` is the last passed gate, and `done` after audit.
Only the CLI writes `state.json`, every `ledger.jsonl`, `active.json`, `evidence/`
(including `_project/`) and `report.md`. The guard hook's `PROTECTED` list must match.
`tests/multidev.test.mjs` merges two feature branches and must stay conflict-free.

**2. Agent layer (Markdown)**: decides who does what, never whether a gate passed.
- `skills/develop/SKILL.md` is the orchestrator, running in the main thread. It loops on `phase`, spawns one subagent per step, **runs `tnt gate` itself after each one**, and routes failures. Subagents only self-check with `tnt check`, a dry run that records nothing. That keeps attempt counts and auto-commits to one per step; the trial showed that double gating made duplicate commits. Defects and missing coverage go through `tnt unlock`, then a new failing test (test-author), then the fix (implementer). Subagents can't spawn subagents, which is why orchestration lives in a skill.
- `agents/*.md`: producers (`test-author`, `implementer`, `scaffolder`, `planner`, `architect`, `codebase-analyst`) and read-only verifiers (`style-verifier`, `code-reviewer`, `functional-tester`, `evidence-auditor`). Verifier names must match the `VERIFIER_WRITABLE` keys in `guard.mjs`.
- `skills/commit/SKILL.md`: a standalone `/tnt:commit` that writes single-line Conventional Commits with no body and no trailers, which deliberately overrides default attribution guidance. The harness's own auto-commits (`COMMIT_ON` in `harness.mjs`) also follow `type(scope): subject`; keep the two consistent.
- `reference/harness-protocol.md`: shared rules every agent reads first, including the final-message block (`STEP/FEATURE/RESULT/EVIDENCE/NOTES`) that the orchestrator parses.
- Skills and agents call the CLI as `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"`. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in Markdown content, but it is not set in the Bash environment.

## Making changes

- Changing a gate rule, CLI flag, file name or JSON shape (review or audit drafts) usually means editing `harness.mjs`, the matching agent prompt, `harness-protocol.md`, and the README gate table together. Add or adjust a test in `tests/tnt.test.mjs` for every gate-rule change: each rule has a negative test proving it rejects.
- Never weaken a gate to make an agent's life easier. Add a recorded, human-attributed escape hatch instead, as `waive` and `unlock` do.
- The plugin must not rely on a newer Claude Code feature without saying so in the README requirements. The developer's PATH `claude` CLI has been older than the desktop app's.
- Commands run with `shell` from `resolveShell()`: Git Bash on Windows (found via `git --exec-path`), otherwise the system shell. Agent-written functional commands assume bash syntax.
