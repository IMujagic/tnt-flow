---
name: plan
description: Plan work in a think-and-type project. A planner subagent slices a request into features with testable specs (AC ids and functional verification plans), then the user reviews and approves each spec. Use when the user describes new functionality, a change or a bug to be built with the workflow.
argument-hint: "<what to build>"
---

# Plan features

`TNT` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"`.

1. If `.tnt/config.json` is missing, tell the user to run `/tnt:onboard`
   (for an existing code base) or `/tnt:new-project` first, and stop.
2. If `$ARGUMENTS` is empty, ask what to build. For a bug, include the reproduction
   steps and the expected and actual behaviour.
3. Spawn `tnt:planner` with the request verbatim and the output of `TNT status`.
4. For each feature it created, review `spec.md` yourself before you show it:
   - Is every AC observable and specific? Does every AC have a functional verification line?
   - Are the negative and edge cases present?
   If something is weak, re-brief the planner once with your concrete objections.
5. Show the user each spec: title, ACs, out-of-scope items, open questions. Resolve the
   open questions with the user, and make the edits through the planner, or edit
   `spec.md` directly if the user dictates the change.
6. Approval belongs to the user. For each spec they accept, run
   `TNT approve <F> --by "<their name>"`. Never approve without an explicit yes.
7. Ask before committing the specs (`docs(F-xxx): spec`). A clean tree is needed before
   `/tnt:develop`.

Finish with `TNT status` and the next step: `/tnt:develop <F>`.
