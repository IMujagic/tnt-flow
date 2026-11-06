---
name: onboard
description: Onboard an existing codebase onto the agentic-wf harness. Analyses the repo with an independent subagent, proves the build/test/lint/format/typecheck commands, records a baseline and sets up .agentic-wf/. Use when the user wants to start using the workflow on an existing project.
disable-model-invocation: true
---

# Onboard an existing project

`WF` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/wf.mjs"`.

1. **Preconditions.** The project must be a git repository. If it is not, ask
   before running `git init`. If `.agentic-wf/config.json` already exists, show
   `WF status` and ask whether to re-onboard, which overwrites the config.
2. Run `WF init --type existing` (add `--force` only if the user agreed to re-onboard).
3. Spawn `agentic-wf:codebase-analyst` with: "Onboard this repository. Write
   `.agentic-wf/config.json` commands and `.agentic-wf/project.md`."
4. Run `WF config check` yourself. Show the user:
   - each configured command with its probe result (exit code and ledger `#seq`)
   - the Risks & gaps section of project.md
   - any `.gitignore` additions needed so test runs don't mutate the tree
   Ask the user to confirm or correct the commands. If tooling is missing (for example,
   no linter), ask whether to add it. If they agree, implement the tooling change as a
   normal harness feature (`/agentic-wf:plan`), or make the minimal config change with
   their explicit approval.
5. Run `WF baseline`. It records test and style on the current tree. If the baseline is
   red, the user must decide: fix it first as a feature (recommended), or narrow
   `commands.test`. The green gate needs the whole suite to pass.
6. Offer to add this to the project's `CLAUDE.md`, and ask before writing it:
   ```
   ## Workflow
   Features are built with the agentic-wf plugin: /agentic-wf:plan → /agentic-wf:develop.
   Specs, evidence and the ledger live in .agentic-wf/ (commit it). Don't hand-edit evidence.
   ```
7. Ask before committing `.agentic-wf/` (and any CLAUDE.md change) as
   `chore: onboard agentic-wf`. A feature cannot start on a dirty tree.

Finish by summarising the commands, the baseline status, the gaps, and the next step,
`/agentic-wf:plan <request>`.
