---
name: status
description: Show think-and-type project and feature status, gate progress, waivers and ledger integrity. Use when the user asks where things stand, what is next, or what evidence exists for a feature.
argument-hint: "[F-xxx]"
---

`TNT` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/tnt.mjs"`.

Run `TNT status $ARGUMENTS` and `TNT ledger verify`. For one feature, also read its
`report.md` if it exists (or produce one with `TNT report <F>`), and list:
- the passed gates, each with its ledger `#seq`, and the next gate
- the latest failed gate attempt and its reasons (from `TNT status <F> --json` attempts and the report's "Failed gate attempts")
- waivers and unlocks, with their reasons

Report only what the CLI output shows. If the ledger check fails, lead with that,
because a broken ledger means no evidence can be trusted.
