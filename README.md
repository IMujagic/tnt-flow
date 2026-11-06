# Think and Type (`tnt`)

A Claude Code plugin that runs an **evidence-gated development workflow**. You plan
features as testable specs. Each feature is then built through a pipeline in which
every step runs as an independent subagent, and a step only counts as passed when
the harness has recorded proof: real command output, bound to the exact code it
was run against.

```
plan ──▶ spec (human approves)
           │
           ▼
  test-author ─▶ [red gate] ─▶ implementer ─▶ [green gate] ─▶ style-verifier ─▶ [style gate]
                                                                                 │
  evidence-auditor ◀─ [functional gate] ◀─ functional-tester ◀─ [review gate] ◀─ code-reviewer
         │
         ▼
   [audit gate] ─▶ done + report.md
```

## What "proof, not claims" means here

| Gate | Passes only when the ledger shows… |
|---|---|
| spec | a human approved the exact `spec.md` content (hash recorded); every AC is concrete |
| red | test files are locked (hashed), every `AC-n` is referenced by a test name (`AC-1`, `test_ac_1_…`, `TestAC1…`, whatever the language allows), and the **configured full suite failed** on the current tree with an AC id in the output |
| green | the full suite passed after red, the locked tests are byte-identical, and the code differs from the red tree (otherwise the suite is flaky) |
| style | every configured lint, format-check and typecheck command exited 0 on the green tree |
| review | an independent review approved the green tree; every finding quotes real code at file:line and every changed file was reviewed |
| functional | each AC has a black-box run on the green tree whose output matched an `--expect` pattern |
| audit | `tnt verify` re-executed the tests, style checks and functional runs from scratch, the hash chain is intact, and a fresh auditor's report passed |

Mechanisms behind this:
- **Hash-chained ledger** (`.tnt/ledger.jsonl`): every run, gate, approval and submission is chained by sha256. Editing an entry or a log is detected.
- **Tree binding**: evidence records a content hash of the working tree, built with a temporary git index. Changing code after green invalidates every later gate.
- **The CLI chooses commands**: red, green and style always run the configured commands, so a step cannot "prove" its work with `true`.
- **Guard hook**: blocks direct writes to evidence and state, blocks edits to locked tests after red, and keeps verifier subagents read-only.
- **Git history**: with `git.autoCommit`, the `[tnt:red]` commit (failing tests) lands before `[tnt:green]`.

## Install

Requirements: a recent Claude Code (check that `claude --version` is current; run
`claude update` if it is not), Node.js 18 or later, and git.

From the root of this repository:

```bash
claude plugin marketplace add .
```

```bash
claude plugin install tnt@think-and-type
```

The marketplace is named `think-and-type`. The plugin id is `tnt`, so its commands
are `/tnt:<skill>` and its agents are `tnt:<agent>`.

To work on the plugin without installing it, run `claude --plugin-dir plugins/think-and-type`.

## Use

| Command | When |
|---|---|
| `/tnt:onboard` | Adopt the workflow in an existing repo: analyse it, prove its commands, record a baseline |
| `/tnt:new-project <idea>` | Greenfield: brief, architect design, scaffold a proven toolchain, seed a backlog |
| `/tnt:plan <request>` | Slice a request into features with AC-based specs; you approve each one |
| `/tnt:develop [F-xxx]` | Run the gated pipeline for a feature; resumable |
| `/tnt:status [F-xxx]` | Gates, attempts, waivers, ledger integrity |
| `/tnt:verify <F-xxx>` | Re-execute all evidence and re-audit, for example before a merge |

Each project gets a `.tnt/` directory. Commit it, because it is the audit trail:

```
.tnt/
  config.json          commands the gates run, git and limit settings
  project.md           architecture, conventions, functional-test approach
  ledger.jsonl         hash-chained evidence ledger (CLI-only)
  features/F-001-…/
    spec.md            acceptance criteria AC-1…n, functional verification plan
    state.json         gate state (CLI-only)
    evidence/          logs, review and audit JSON, artifacts (CLI-only)
    report.md          generated evidence report
```

### Configuration (`.tnt/config.json`)

```json
{
  "commands": { "test": "npm test", "lint": "npm run lint", "format_check": "npx prettier --check .", "typecheck": "npx tsc --noEmit", "build": null },
  "style": ["lint", "format_check", "typecheck"],
  "git": { "autoCommit": true, "branchPerFeature": true, "branchPrefix": "tnt/" },
  "red": { "requireAcInOutput": true },
  "limits": { "maxIterations": 3 },
  "timeouts": { "commandMs": 900000 },
  "shell": null
}
```

Commands run through Git Bash on Windows when it can be found, and through `sh`
elsewhere. Set `shell` to override this.

## Escape hatches

- `tnt unlock <F> --reason …` reopens locked tests. It resets red and every later gate, and the new or changed tests must fail again before implementation continues.
- `tnt waive <F> <gate> --reason … --by <human>` records a human decision to skip a gate. Waivers are permanent in the ledger and flagged in reports.

## Limits

The harness makes faking evidence hard and easy to detect, but not impossible. An
agent with shell access could, in principle, rewrite the whole ledger chain. The
defences are the guard hook, the git history, and `tnt verify` re-execution, which
does not trust recorded results. Treat `report.md` together with `tnt verify` as the
proof, not either one alone.

## Developing this plugin

See [CLAUDE.md](CLAUDE.md).
