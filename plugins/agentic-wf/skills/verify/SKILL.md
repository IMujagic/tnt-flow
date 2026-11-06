---
name: verify
description: Independently re-verify an agentic-wf feature: re-execute its tests, style checks and functional evidence from scratch, check ledger integrity, and have a fresh auditor subagent judge the evidence. Use when the user asks to double-check, audit or prove a feature (for example before a merge or a release).
argument-hint: "<F-xxx>"
---

`WF` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/wf.mjs"`.

1. Run `WF verify $ARGUMENTS` yourself and show the result verbatim.
2. Spawn a **fresh** `agentic-wf:evidence-auditor` for the feature. Brief it with the
   feature id only: no earlier conclusions, no hints.
3. Run `WF gate $ARGUMENTS audit` and `WF report $ARGUMENTS`.
4. Report to the user: the verify result, the auditor's failed checks (if any), and
   the report path. If the feature was already `done` and verification now fails,
   say so prominently. Its proof no longer holds for the current code.

Do not fix anything here. Offer to route the failures through `/agentic-wf:develop`.
