---
name: develop
description: Build an approved feature through the evidence-gated pipeline (red, green, style, review, functional, audit), with each step run by an independent subagent and each gate decided by recorded evidence. Use when the user asks to implement, build, develop or resume a planned think-and-type feature (F-xxx).
argument-hint: "[F-xxx]"
---

# Develop a feature through the harness

You are the **orchestrator**. You route work between subagents and run gates. You
never write production code, tests or evidence yourself. That separation is what
makes each step independent.

`TNT` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"` (run it from the project root).

## 0. Pick the feature

- Feature: `$ARGUMENTS`. If it is empty, run `TNT status` and pick the active feature, or else the first feature whose phase is `spec`. If none qualifies, tell the user to run `/tnt:plan` and stop.
- Run `TNT status <F> --json`. If `gates.spec` is missing, the spec is not approved: show `spec.md` to the user, ask for approval, then run `TNT approve <F> --by "<their name>"`. Never approve on the user's behalf.
- If `started` is false, run `TNT start <F>`. It needs a clean tree and creates the branch.

## 1. Pipeline

Loop on `phase` from `TNT status <F> --json` until it reads `done`:

| phase | spawn subagent | then run |
|---|---|---|
| `spec` | `tnt:test-author` | `TNT gate <F> red` |
| `red` | `tnt:implementer` | `TNT gate <F> green` |
| `green` | `tnt:style-verifier` | `TNT gate <F> style` |
| `style` | `tnt:code-reviewer` | `TNT gate <F> review` |
| `review` | `tnt:functional-tester` | `TNT gate <F> functional` |
| `functional` | `tnt:evidence-auditor` | `TNT gate <F> audit` |

**Always run the gate yourself after the subagent returns**, whatever the subagent
says. The gate's verdict is the only one that counts. Subagents self-check with
`TNT check`, which records nothing. Exactly one `TNT gate` call per step comes from
you, so attempts and commits stay accurate. Run it once per subagent return; never
run it again to "confirm".

### Integrating the base branch (once, right after green)

Other developers keep merging into the base branch. Evidence for code that sits on a
stale base doesn't prove the code that will actually ship. So when the phase reaches
`green` and `syncedBase` in `TNT status <F> --json` is still null, integrate before
you spawn the style-verifier:

1. Pick the base: `baseBranch` from `TNT status <F> --json`. If the repo has a remote, run `git fetch` and use `origin/<baseBranch>` when it exists.
2. If `git merge-base --is-ancestor <base> HEAD` succeeds, the base is already merged. Skip to step 4.
3. Tell the user the base has moved and ask before merging. With their yes, run `git merge --no-edit <base>`. If it conflicts, stop and show the user the conflicting files. Never resolve conflicts in locked tests yourself.
4. Run `TNT sync <F> --onto <base>`. If it says the code changed, green and every later gate were reset. The loop resumes at `red`, so the implementer re-records green on the merged code.
5. If sync refuses because the merge changed locked tests, show the user `git diff <base> -- <files>` and the ACs those tests cover. Only on their explicit decision, run `TNT sync <F> --onto <base> --relock --by "<their name>" --reason "<why>"`.

Integrate once per feature. If the base moves again later, don't loop. CI checks the
real merge result with `tnt verify --integrated` (see the README).

### Briefing a subagent (the independence rules)

Every prompt contains only:
- the feature id and its directory (from `status`)
- the step's goal in one line
- on a retry: the **verbatim** `TNT gate` failure output, plus paths to the logs or JSON files it cites

Never forward one subagent's summary, reasoning or claims to another subagent. A
verifier gets no hint of what the producer believes it did. Verifiers start fresh
every time: never resume an earlier reviewer or auditor.

## 2. Routing failures

Count the attempts with the `attempts` field. When a gate's attempts reach
`maxIterations`, stop and escalate to the user (see 3).

**Models.** Each agent's model is set in its definition to save usage: mechanical
steps run on Sonnet (`test-author`, `implementer`, `functional-tester`) or Haiku
(`style-verifier`). Judgment steps inherit the session model (`code-reviewer`,
`evidence-auditor`). When you re-brief a Sonnet producer for a gate whose
`attempts` is already 2 or more, spawn it with `model: "opus"`, because two cheap
attempts already failed and a stronger model costs less than another failed attempt. Never downgrade a
verifier, and never pick a model to make a gate easier to pass.

- **red fails**: re-brief `test-author` with the gate output.
- **green fails**: re-brief `implementer` with the gate output and the green log path. If the implementer returns `blocked` because a locked test contradicts the spec, show the user the quoted test and the AC. With their agreement, either fix the spec (it must be re-approved) or run `TNT unlock <F> --reason "<why>"` and re-run `test-author`.
- **After any implementer fix** (style, review, functional or audit): run `TNT gate <F> green` before anything else. Code changes invalidate the evidence recorded after green. Passing green again resets the later gates, and the loop resumes at style.
- **style fails**: send the style-verifier's violation list to `implementer`.
- **review: changes_requested**: read the newest `evidence/*-review.json`.
  - Findings with `needs_test: true` mean missing behaviour. Run `TNT unlock <F> --reason "review <ids>: missing coverage"`, then `test-author` with those findings. That gives a new failing test, then implementer, and so on.
  - All other blocking, major and minor findings go to `implementer` with the review file path.
  - The next review always comes from a **new** reviewer instance.
- **functional fails**:
  - *defect*: `TNT unlock` with the reason, then `test-author` writes a failing test that reproduces the defect, then implementer. A defect always gets a regression test first.
  - *environment*: tell the user exactly what is missing and stop.
  - *spec gap*: show the user. The spec must be edited and re-approved.
- **audit fails**: route each failed check to the step that owns it. A weak test goes to unlock and test-author; unresolved findings go to implementer; non-reproducible functional evidence goes to functional-tester.

Waivers (`TNT waive`) are only for an explicit user decision. Ask, quote their reason,
and record `--by` with their name. Never suggest a waiver as the first option.

## 3. Escalation

When you stop for the user, show:
- the feature, its phase, and the gate that is failing
- the last gate output, verbatim
- what each attempt changed, from the subagents' NOTES
- two or three concrete options

Then wait.

## 4. Finish

When the phase is `done`:
1. Run `TNT report <F>`, `TNT ledger verify` and `TNT view <F>`. The last one writes `.tnt/view.html`, a timeline of the ledger with code diffs.
2. Show the user the report and viewer paths, the gate table, the commits (`git log --oneline <base>..`), and any waivers or unlocks.
3. Suggest the next feature from `TNT status`. Do not merge or push. The user decides that. Remind them that a pull request should pass `tnt verify --integrated` on its merge result, because the feature's own evidence covers only the branch's tree.
