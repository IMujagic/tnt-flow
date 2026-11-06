---
name: new-project
description: Start a greenfield project with the agentic-wf harness. Interviews the user, has an architect subagent design it, has a scaffolder subagent bootstrap a proven toolchain and walking skeleton, and seeds the feature backlog. Use when the user wants to create a new project with this workflow.
disable-model-invocation: true
argument-hint: "[short project description]"
---

# New project

`WF` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/wf.mjs"`.

## 1. Brief (you, with the user)

Start from `$ARGUMENTS`. Ask only what the brief leaves open, in at most two short
rounds of questions:
- the problem, the primary users, and what "first release done" means
- the kind of system (CLI, web API, web app, library, mobile, data pipeline)
- constraints: language or stack preferences, hosting, data, compliance, team familiarity
- non-goals

Write the answers to `.agentic-wf/brief.md` once `.agentic-wf/` exists (step 2).

## 2. Repository

If the directory is not a git repository, run `git init` (ask first if the directory
already has files). Then run `WF init --type greenfield`.

## 3. Design (subagent)

Spawn `agentic-wf:architect` with the path to `brief.md`. Then show the user the key
parts of `.agentic-wf/project.md`: stack, architecture, decisions, toolchain,
functional verification approach, open questions, and backlog. Iterate with the
architect (a fresh brief that includes the user's feedback) until the user approves.

## 4. Scaffold (subagent)

Spawn `agentic-wf:scaffolder`. When it returns, verify independently. Do not rely on
its report:
- `WF config check` must pass
- `WF baseline` must show every command at exit 0 and none MUTATED

If either fails, re-brief the scaffolder with the verbatim output, at most
`limits.maxIterations` times, then escalate to the user.

Show the user the file tree and the baseline results. Ask before committing:
`chore: scaffold project and agentic-wf harness`.

## 5. Seed the backlog

Spawn `agentic-wf:planner` once per backlog item in project.md, in order, or once
with the whole list if the items are small. Show the user the resulting features and
specs. Specs need explicit approval (`WF approve <F> --by "<name>"`) before
development. Offer to approve them one at a time as they review.

Finish with `WF status` and the next step: `/agentic-wf:develop F-001`.
