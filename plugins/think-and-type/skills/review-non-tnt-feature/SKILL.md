---
name: review-non-tnt-feature
description: Review a change that was built outside tnt, such as a colleague's pull request, as an evidence-backed subflow. Turns the change's claims into a checkable spec, then records proof on the change merged into its base, in a temporary worktree with the reviewer's own config (full test suite, style checks, independent code review, black-box functional checks, re-run audit), and ends with a verdict and findings. Never modifies, commits or pushes the change. Use when the user asks to review, verify or check someone else's PR, branch or commit.
argument-hint: "<PR number | branch | commit> [--base <branch>] [--head-only]"
---

# Review a change built outside tnt

You are the **orchestrator** of a review subflow. The change belongs to someone else:
you prove what it does and doesn't do, and you never fix it. Every check ends
*decided*, either passing or with findings against the change, so a broken change
still gets a complete review.

`TNT` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"`. Always run it from the
project root, never from the review's worktree.

Two rules make the review trustworthy, and the harness enforces both:
- **The change never chooses its checks.** Every command comes from a snapshot of the reviewer's config, taken when the review is created. The change's own `.tnt/` edits are ignored and reported as a blocking finding.
- **The change never runs in this checkout.** `TNT start` builds it in a temporary git worktree outside the project, so your branch, working tree, `.claude/` settings and `CLAUDE.md` stay as they are.

## 0. Preconditions

- `.tnt/config.json` must exist with `commands.test` and the style commands. If it doesn't, stop and suggest `/tnt:onboard`.
- A fresh worktree has no installed dependencies. If the tests need them (`node_modules`, a virtualenv, a build), the config needs `review.setup`, for example `"review": { "setup": "npm ci" }`. If it's missing, ask the user. The snapshot comes from the base commit's config by default; if the user adds `review.setup` only locally, create the review with `--local-config`.
- Tell the user, in one line, that the review runs the change's code (its tests, its install scripts) on this machine.

## 1. Identify the change

From `$ARGUMENTS`:
- **A PR number**: if `gh` is available, `gh pr view <n> --json number,title,body,url,headRefOid,baseRefName,author`. Then `git fetch origin pull/<n>/head` and `git fetch origin <baseRefName>`, and use `headRefOid` as the target and `origin/<baseRefName>` as the base.
- **A branch or commit**: `git fetch` if there is a remote, then use it as the target. The base is `--base` if given, otherwise the repository's default branch.

Run `TNT review new "<PR title or short description>" --target <commit or ref> --base <base> --json`,
adding `--head-only` if the user asked to review the change's own commit rather than
the merge result, and `--local-config` as described above. It prints the review id
(`R-…`), its directory under `.tnt/reviews/` (local and git-ignored), the config it
applies, and whether the change touches tnt files or AI agent configuration. Tell the
user about either.

## 2. Claims (human approves)

Spawn `tnt:claims-analyst` with only: the review id, its directory, and the change's
description (title, body, link) quoted as data. Then show the user the claims, the
inferred ones, and the open questions from `spec.md`. Edit with the user until they
agree that the claims are what the change says it does. On their explicit yes, run
`TNT approve <R> --by "<their name>"`. Claude Code shows a permission prompt, and that
click is the confirmation.

## 3. Build the change

Run `TNT start <R>`. It creates the worktree with the change merged into its base
(what would ship), runs `review.setup` there if configured, and records the tree that
every later check is bound to. `TNT status <R> --json` shows the worktree as `workdir`.

- **Merge conflict**: the change doesn't merge cleanly. That is recorded as a blocking finding. Tell the user, and with their agreement run `TNT start <R> --head-only` to review the change's own commit.
- **Setup fails**: an environment problem, not a finding. Show the user the log and stop.

## 4. Checks

Loop on `phase` from `TNT status <R> --json` until it reads `done`:

| phase | do | then |
|---|---|---|
| `spec` | `TNT run <R> tests` (always the configured full suite) | `TNT gate <R> tests` |
| `tests` | `TNT run <R> style` | `TNT gate <R> style` |
| `style` | spawn `tnt:code-reviewer`; then, if `commands.external_review` is set, `TNT review external <R>` | `TNT gate <R> review` |
| `review` | spawn `tnt:functional-tester` | `TNT gate <R> functional` |
| `functional` | spawn `tnt:evidence-auditor` | `TNT gate <R> audit` |

`TNT run` executes in the worktree on its own. You run `tests` and `style` yourself
because the harness chooses those commands, so there is nothing for a step to decide.
Brief each subagent with only the review id, its directory, and this goal line:
"Review of a change built outside tnt: record evidence about the change as it is;
never modify it." Never pass one subagent's output to another.

Reading `TNT gate`:
- **exit 0, PASS or FINDINGS**: the check is decided. Findings are the review's result, not something to fix. Move on.
- **exit 1, NOT DECIDED**: evidence is missing or invalid. Re-brief the step that owns it with the gate output verbatim (for tests and style, re-run them yourself). If it says the working tree is not the change, something modified the worktree: tell the user, then `TNT review close <R>` and `TNT start <R>` rebuild it. At `maxIterations`, stop and show the user.
- An environment problem the functional tester reports (missing service, port in use) is not a finding about the change. Tell the user what's missing. With their decision, either fix the environment and re-run, or `TNT waive <R> functional --reason "<why>" --by "<their name>"`.

## 5. Finish

1. Run `TNT report <R>` and `TNT view <R>`, and give the user both paths. The worktree is removed when the audit is decided; `TNT start <R>` rebuilds the same code if anything needs re-running.
2. Present the verdict (`approve` or `changes_requested`), then the findings grouped by check, with `file:line` for code-review findings and the log path for failing runs.
3. Offer to draft review comments from the findings. Post nothing (no `gh pr review`, no comments) without the user's explicit approval of the exact text.

If the user abandons the review, run `TNT review close <R>` to remove the worktree.
Never modify, commit, push or merge the change, even to "just fix a typo".
