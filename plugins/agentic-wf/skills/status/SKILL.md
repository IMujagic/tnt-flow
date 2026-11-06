---
name: status
description: Show agentic-wf project and feature status, gate progress, waivers and ledger integrity. Use when the user asks where things stand, what is next, or what evidence exists for a feature.
argument-hint: "[F-xxx]"
---

`WF` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/wf.mjs"`.

Run `WF status $ARGUMENTS` and `WF ledger verify`. For one feature, also read its
`report.md` if it exists (or produce one with `WF report <F>`), and list:
- the passed gates, each with its ledger `#seq`, and the next gate
- the latest failed gate attempt and its reasons (from `WF status <F> --json` attempts and the report's "Failed gate attempts")
- waivers and unlocks, with their reasons

Report only what the CLI output shows. If the ledger check fails, lead with that,
because a broken ledger means no evidence can be trusted.
