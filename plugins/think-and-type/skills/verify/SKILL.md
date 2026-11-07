---
name: verify
description: Independently re-verify a think-and-type feature: re-execute its tests, style checks and functional evidence from scratch, check ledger integrity, and have a fresh auditor subagent judge the evidence. Use when the user asks to double-check, audit or prove a feature (for example before a merge or a release).
argument-hint: "<F-xxx>"
---

`TNT` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"`.

1. Run `TNT verify $ARGUMENTS` yourself and show the result verbatim.
2. Spawn a **fresh** `tnt:evidence-auditor` for the feature. Brief it with the
   feature id only: no earlier conclusions, no hints.
3. Run `TNT gate $ARGUMENTS audit` and `TNT report $ARGUMENTS`.
4. Report to the user: the verify result, the auditor's failed checks (if any), and
   the report path. If the feature was already `done` and verification now fails,
   say so prominently. Its proof no longer holds for the current code.

If the user wants to check a merge result (a pull request's merge commit, or the base
branch after features were merged), run `TNT verify --integrated` instead, optionally
followed by feature ids. It re-proves every done feature on the current tree, runs the
suite and style checks once, and records nothing. Show its output verbatim and skip
steps 2 and 3.

Do not fix anything here. Offer to route the failures through `/tnt:develop`.
