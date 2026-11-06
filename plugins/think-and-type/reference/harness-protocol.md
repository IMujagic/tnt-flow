# think-and-type harness protocol

Every workflow step runs as its own subagent with a fresh context. Read this
before you act. These rules override habits.

## 1. Proof, not claims

- A statement such as "tests pass" or "lint is clean" counts only when a ledger entry
  recorded by the `tnt` CLI backs it. Your final message must cite ledger entries as
  `#<seq>`, and the orchestrator checks them with `tnt gate`. Nobody trusts your summary.
- Evidence is bound to a **tree hash**: the content of the working tree, not including
  `.tnt/`. Once you change any code, every earlier piece of evidence stops
  applying to the new code.
- You never write files under `.tnt/` yourself, except `spec.md`, `project.md`,
  and draft files that your instructions name. A hook blocks the rest.
- Never fake, filter or summarise command output into evidence. Run the real
  command through `tnt run` and let it record the result.

## 2. The CLI

`TNT` means: `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"`. If that path did not
substitute, the session-start context gives you the absolute path. Run it from the
project root. Useful commands:

| Purpose | Command |
|---|---|
| Feature state | `TNT status <F> --json` |
| Freeze test files | `TNT lock-tests <F> <files...>` |
| Record the test suite | `TNT run <F> red` / `TNT run <F> green` (always the configured full suite) |
| Record style checks | `TNT run <F> style` |
| Record a functional check | `TNT run <F> functional --ac AC-n --expect "<regex>" -- "<command>"` |
| Record anything else | `TNT run <F> probe -- "<command>"` |
| Submit review / audit | `TNT review submit <F> <file>` / `TNT audit submit <F> <file>` |
| Re-execute all evidence | `TNT verify <F>` |
| Self-check a gate (dry run) | `TNT check <F> <gate>` |

**Never run `TNT gate`.** Deciding a gate is the orchestrator's job, and each `gate`
call is recorded, counts as an attempt, and may commit. Use `TNT check` to see what
the gate will say. It records nothing.

Logs land in `.tnt/features/<F>/evidence/`. Read them to diagnose a failure.

## 3. Step boundaries

| Role | May change | Must not change |
|---|---|---|
| test-author | test files, test fixtures, minimal stubs needed so the tests compile | production behaviour |
| implementer | production code, non-locked test helpers | locked test files, spec, config |
| style-verifier, code-reviewer, functional-tester, evidence-auditor | only their own draft files | source code or tests |

If your step cannot succeed within its boundary, because the spec is ambiguous, a
locked test is wrong, or the environment is broken, **stop and report it**. Do not
work around it. The orchestrator owns routing.

## 4. Traceability

- Acceptance criteria have IDs (`AC-1`, `AC-2`, ...) in `spec.md`.
- Every AC is covered by at least one test whose name contains its ID, for example
  `test("AC-2: rejects expired tokens")`.
- Functional evidence is recorded per AC with `--ac AC-n`.

## 5. Evidence hygiene

- A recorded run must not modify the working tree. If a command generates files,
  such as caches, coverage or build output, they must be in `.gitignore`, or the run
  is flagged `MUTATED` and rejected. Report this rather than deleting the files.
- Functional commands must be self-contained and reproducible, because `tnt verify`
  re-runs them later. Start what you need, probe it, stop it, all in one command or
  script.
- Prefer `--expect` patterns that match a specific observable value, such as
  `"status=201"` or `"total: 42.00"`. A generic pattern like `"ok"` proves little.

## 6. Final message format

End with exactly this block. The orchestrator parses it:

```
STEP: <role>
FEATURE: <F-id>
RESULT: done | blocked
EVIDENCE: #<seq>, #<seq>, ...
NOTES: <one to five lines: what changed, or why you are blocked>
```
