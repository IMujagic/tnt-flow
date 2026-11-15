# think-and-type harness protocol

Every workflow step runs as its own subagent with a fresh context. These rules
override habits. This file is the source: `npm run build:agents` copies the sections
each agent needs into the end of its own instructions (`agents/*.md`), filtered by the
`roles` line under each heading. Edit here, then rebuild.

## 1. Proof, not claims
<!-- roles: all -->

- A statement such as "tests pass" or "lint is clean" counts only when a ledger entry
  recorded by the `tnt` CLI backs it. Your final message must cite ledger entries as
  `#<seq>`, and the orchestrator checks them with `tnt gate`. Nobody trusts your summary.
- Evidence is bound to a **tree hash**: the content of the working tree, not including
  `.tnt/`. Once you change any code, every earlier piece of evidence stops
  applying to the new code.
- Each feature has its own ledger (`.tnt/features/<F-dir>/ledger.jsonl`), so `#<seq>`
  always means an entry in that feature's ledger. Project-wide events live in
  `.tnt/_project/`.
- You never write files under `.tnt/` yourself, except `spec.md`, `project.md`,
  and draft files that your instructions name. A hook blocks the rest.
- Never fake, filter or summarise command output into evidence. Run the real
  command through `tnt run` and let it record the result.

## 2. The CLI
<!-- roles: all -->

`TNT` means: `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"`. If that path did not
substitute, the session-start context gives you the absolute path. Run it from the
project root. Useful commands:

| Purpose | Command |
|---|---|
| Feature state | `TNT status <F> --json` |
| Freeze test files | `TNT lock-tests <F> <files...>` (adds to the set; `--replace` sets it anew, dropping files no longer listed) |
| Record the test suite | `TNT run <F> red` / `TNT run <F> green` (always the configured full suite) |
| Record style checks | `TNT run <F> style` |
| Record a functional check | `TNT run <F> functional --ac AC-n --expect "<regex>" -- "<command>"` |
| Record anything else | `TNT run <F> probe -- "<command>"` |
| Submit review / audit | `TNT review submit <F> <file>` / `TNT audit submit <F> <file>` |
| Re-execute all evidence | `TNT verify <F>` |
| Self-check a gate (dry run) | `TNT check <F> <gate>` |

**Never run `TNT gate`.** Deciding a gate is the orchestrator's job, and each `gate`
call is recorded, counts as an attempt, and may commit. Use `TNT check` to see what
the gate will say. It records nothing. `TNT sync`, `TNT unlock` and `TNT waive` also
belong to the orchestrator and the human, never to a step. Don't commit, merge,
rebase, reset, stash, check out, restore or push either: the harness commits, and
the orchestrator merges. A hook blocks all of these inside a step, and blocks
importing the harness modules directly. If you need one, stop and report it.

Logs land in `.tnt/features/<F>/evidence/`. When your brief quotes gate output, start
from the failing lines it shows ("failing output of #n") and open the full log only
if they aren't enough. Logs can be long; read the part you need.

### Reviews of changes built outside tnt
<!-- roles: claims-analyst, code-reviewer, functional-tester, evidence-auditor -->

Ids starting `R-` are reviews of someone else's change (`/tnt:review-non-tnt-feature`).
They live in `.tnt/reviews/<R-dir>/`, and their checks are spec → tests → style →
review → functional → audit. The change is never modified. A check is decided with
a pass or with findings against the change, and both are valid outcomes. Only missing
or invalid evidence needs another attempt. `TNT status <R> --json` gives `dir`, `base`,
`target` and `workdir`: the code under review is built in a temporary worktree
outside the project, and `TNT run` executes there with the reviewer's config, never
the change's own. Read the change's code in `workdir`, and run `TNT` from the project
root.

## 3. Step boundaries
<!-- roles: test-author, implementer, code-reviewer, functional-tester, evidence-auditor, claims-analyst -->

| Role | May change | Must not change |
|---|---|---|
| test-author | test files, test fixtures, minimal stubs needed so the tests compile | production behaviour |
| implementer | production code, non-locked test helpers | locked test files, spec, config |
| code-reviewer, functional-tester, evidence-auditor | only their own draft files | source code or tests |
| claims-analyst | only the review's `spec.md` | anything else |

If your step cannot succeed within its boundary, because the spec is ambiguous, a
locked test is wrong, or the environment is broken, **stop and report it**. Do not
work around it. The orchestrator owns routing.

## 4. Traceability
<!-- roles: planner, claims-analyst, test-author, implementer, code-reviewer, functional-tester, evidence-auditor -->

- Acceptance criteria have IDs (`AC-1`, `AC-2`, ...) in `spec.md`.
- Every AC is covered by at least one test whose **name** contains its ID. The name has
  to show up in the runner's failure output, which is why a comment is not enough.
  Use the form the language allows:

  | Test names are… | Example for AC-2 |
  |---|---|
  | strings (JS/TS, JUnit `@DisplayName`, RSpec, xUnit `DisplayName`) | `test("AC-2: rejects expired tokens")` |
  | snake_case identifiers (pytest, Rust) | `test_ac_2_rejects_expired_tokens`, `ac2_rejects_expired_tokens` |
  | PascalCase or camelCase identifiers (Go, Java and C# methods) | `TestAC2RejectsExpiredTokens`, `ac2RejectsExpiredTokens` |

  The harness accepts `AC-2`, `AC 2`, `AC2`, `ac_2` and `ac2` in any letter case. It never
  confuses `AC-2` with `AC-20`.
- Functional evidence is recorded per AC with `--ac AC-n`.

## 5. Evidence hygiene
<!-- roles: planner, claims-analyst, codebase-analyst, scaffolder, test-author, implementer, functional-tester, evidence-auditor -->

- A recorded run must not modify the working tree. If a command generates files,
  such as caches, coverage or build output, they must be in `.gitignore`, or the run
  is flagged `MUTATED` and rejected. Report this rather than deleting the files.
- Functional commands must be self-contained and reproducible, because `tnt verify`
  re-runs them later. Start what you need, probe it, stop it, all in one command or
  script.
- Prefer `--expect` patterns that match a specific observable value, such as
  `"status=201"` or `"total: 42.00"`. A generic pattern like `"ok"` proves little.
- The approved spec's functional verification plan gives each AC `Expect: \`<regex>\``
  patterns. The harness checks every functional run's output against them, and the
  functional gate and `tnt verify` fail unless some run for the AC prints each one.
  They belong to the human-approved spec: never change them to make a gate pass.

## 6. Final message format
<!-- roles: all -->

End with exactly this block. The orchestrator parses it:

```
STEP: <role>
FEATURE: <F-id or R-id>
RESULT: done | blocked
EVIDENCE: #<seq>, #<seq>, ...
NOTES: <one to five lines: what changed, or why you are blocked>
```
