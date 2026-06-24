# PRD: Session reliability: diagnose, fix, and surface root cause for failing mctrl sessions

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Session lifecycle, run coordinator, provider error surfaces, approval application path |
| Related plans | `.omo/plans/coding-agent-runtime-hardening.md` |

## Background

Multiple `session_<id>` runs failed during normal prompt execution. Failures were opaque. Separately, per-session approval grants were not applying, and `aggressive`-level `command.run` auto-approve was not taking effect — suggesting the failures and the approval application share a root cause worth investigating together.

## Goals

- Sessions complete reliably on a normal prompt run.
- Failure cause is surfaced, not opaque.
- Approval behavior matches the configured level.

## Non-Goals

- (none stated)

## Requirements

1. Diagnose and fix recurring session failures so a normal prompt run completes.
2. Surface the underlying failure cause (provider, tool, approval, graph) instead of an opaque failure marker.
3. "Allow for this session" approval grants must apply within the session they were issued.
4. Approval level `aggressive` and above must auto-approve `command.run`.
5. Address the recurring failure pattern, not just individual session IDs.

## Acceptance Criteria

- A representative failing session completes successfully after the fix.
- Failed runs expose a categorized cause.
- Per-session approval grants and aggressive command.run both work.
