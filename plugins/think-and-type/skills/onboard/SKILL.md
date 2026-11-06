---
name: onboard
description: Onboard an existing codebase onto the think-and-type harness. Analyses the repo with an independent subagent, proves the build/test/lint/format/typecheck commands, records a baseline and sets up .tnt/. Use when the user wants to start using the workflow on an existing project.
disable-model-invocation: true
---

# Onboard an existing project

`TNT` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"`.

1. **Preconditions.** The project must be a git repository. If it is not, ask
   before running `git init`. If `.tnt/config.json` already exists, show
   `TNT status` and ask whether to re-onboard, which overwrites the config.
2. Run `TNT init --type existing` (add `--force` only if the user agreed to re-onboard).
3. Spawn `tnt:codebase-analyst` with: "Onboard this repository. Write
   `.tnt/config.json` commands and `.tnt/project.md`."
4. Run `TNT config check` yourself. Show the user:
   - each configured command with its probe result (exit code and ledger `#seq`)
   - the Risks & gaps section of project.md
   - any `.gitignore` additions needed so test runs don't mutate the tree
   Ask the user to confirm or correct the commands. If tooling is missing (for example,
   no linter), ask whether to add it. If they agree, implement the tooling change as a
   normal harness feature (`/tnt:plan`), or make the minimal config change with
   their explicit approval.
5. Run `TNT baseline`. It records test and style on the current tree. If the baseline is
   red, the user must decide: fix it first as a feature (recommended), or narrow
   `commands.test`. The green gate needs the whole suite to pass.
6. Offer to add this to the project's `CLAUDE.md`, and ask before writing it:
   ```
   ## Workflow
   Features are built with the think-and-type plugin: /tnt:plan → /tnt:develop.
   Specs, evidence and the ledger live in .tnt/ (commit it). Don't hand-edit evidence.
   ```
7. Ask before committing `.tnt/` (and any CLAUDE.md change) as
   `chore: onboard think-and-type`. A feature cannot start on a dirty tree.

Finish by summarising the commands, the baseline status, the gaps, and the next step,
`/tnt:plan <request>`.
