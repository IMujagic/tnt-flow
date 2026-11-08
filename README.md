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
- **Hash-chained ledgers**: every run, gate, approval and submission is chained by sha256, with one chain per feature (`.tnt/features/<F>/ledger.jsonl`) and one for project events (`.tnt/_project/ledger.jsonl`). Editing an entry or a log is detected.
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
| `/tnt:verify <F-xxx>` | Re-execute all evidence and re-audit, for example before a merge. Ask it to check a merge result to run `tnt verify --integrated` |
| `/tnt:commit [hint]` | Commit current changes as single-line Conventional Commits (`type(scope): subject`), with no body and no co-author trailers; unrelated changes are split into separate commits |

Each project gets a `.tnt/` directory. Commit it, because it is the audit trail:

```
.tnt/
  config.json          commands the gates run, git and limit settings
  project.md           architecture, conventions, functional-test approach
  .gitignore           keeps active.json (this checkout's current feature) out of git
  _project/
    ledger.jsonl       hash chain for init, baseline and project probes (CLI-only)
    evidence/          baseline logs (CLI-only)
  features/F-7KQ2MX-…/
    spec.md            acceptance criteria AC-1…n, functional verification plan
    ledger.jsonl       this feature's hash chain (CLI-only)
    state.json         gate state (CLI-only)
    evidence/          logs, review and audit JSON, artifacts (CLI-only)
    report.md          generated evidence report
```

Feature ids are random (`F-` and six characters), so features planned on different
branches never get the same id. Pass `tnt new "<title>" --id F-042` to choose one,
for example to match a ticket.

## Models and usage

Each agent's model is set in its frontmatter (`agents/*.md`), so you only pay for
deep reasoning where the step needs it:

| Model | Agents | Why |
|---|---|---|
| inherit (your session model) | `architect`, `planner`, `code-reviewer`, `evidence-auditor` | design, specs and independent judgement: a weak spec or a missed review finding costs more than the tokens |
| `sonnet` | `test-author`, `implementer`, `functional-tester`, `scaffolder`, `codebase-analyst` | well-scoped work against a spec, checked by a gate afterwards |
| `haiku` | `style-verifier` | runs the configured linters and reports their output |

The gates decide pass or fail from recorded evidence whatever model produced it, so
a cheaper producer can't lower the bar. It can only take more attempts. To keep that
bounded, `/tnt:develop` respawns a Sonnet producer with Opus once a gate has failed
twice. To change a default, edit the `model:` line of the agent (`sonnet`, `opus`,
`haiku`, `inherit` or a full model id).

The orchestrator (`/tnt:develop`) runs in your main session, so your session model
applies to it. Its work is routing, and Sonnet handles that well.

## Working in a team

The layout is designed so that git merges don't conflict:

- **One ledger per feature.** A feature is built on its own branch, so two developers never append to the same chain. Merging two finished features adds two directories and touches nothing shared. Rule of thumb: one owner per feature. If two people need to work on one, split it into two features.
- **Local state stays local.** `active.json` (one active feature per checkout) is git-ignored.
- **Integrating the base branch.** Once green passes, `/tnt:develop` merges the base branch into the feature branch (after asking you), then runs `tnt sync <F>`. That records the new base, limits the code review to the feature's own diff, and resets green and every later gate if the merge changed the code, so the merged code is proven again. If the merge changed a locked test, `sync` refuses until a human re-locks it with `--relock --by … --reason …`.
- **CI checks the merge result.** The evidence on a branch is bound to that branch's tree, and the merge commit is code nobody ran. `tnt verify --integrated` re-runs the full suite and style checks, plus the functional checks of every done feature, on the checked-out tree. It fails if a feature in the tree isn't done, and it writes nothing to `.tnt/`. `--out <dir>` saves logs and a `summary.json` for CI artifacts.

GitHub Actions example (`pull_request` checks out the merge commit):

```yaml
name: tnt
on: pull_request
jobs:
  integrated:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with: { repository: IMujagic/tnt-flow, path: .tnt-cli }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci   # whatever your configured commands need
      - run: printf '.tnt-cli/\ntnt-ci/\n' >> .git/info/exclude
      - run: node .tnt-cli/plugins/think-and-type/scripts/tnt.mjs verify --integrated --out tnt-ci
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: tnt-integrated, path: tnt-ci }
```

The CLI checkout and the log directory are excluded from git so that they don't count as working-tree changes.

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
- `tnt sync <F> --relock --by <human> --reason …` accepts locked tests that a merge from the base branch changed. The new hashes, the person and the reason are recorded.

## Upgrading from 0.1

Version 0.1 kept one `.tnt/ledger.jsonl` for the whole project, which conflicted on
every merge. The CLI now refuses that layout. Move `.tnt/` aside and run `tnt init`
to start a fresh audit trail (git history keeps the old one).

## Limits

The harness makes faking evidence hard and easy to detect, but not impossible. An
agent with shell access could, in principle, rewrite the whole ledger chain. The
defences are the guard hook, the git history, and `tnt verify` re-execution, which
does not trust recorded results. Treat `report.md` together with `tnt verify` as the
proof, not either one alone.

## Developing this plugin

See [CLAUDE.md](CLAUDE.md).
