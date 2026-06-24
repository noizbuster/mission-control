# PRD: Approval system: visible level state and real-time policy application

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Approval level UI in the chat footer, approval policy store, policy application path |

## Background

The active approval level was not visible in the chat footer and did not persist across sessions. Policy changes via `/approval` only applied at the next prompt boundary, not to in-flight tool calls.

## Goals

- Approval level is visible and persistent.
- Policy changes apply immediately to in-flight tool calls.

## Non-Goals

- (none stated)

## Requirements

1. The active approval level renders in the chat footer.
2. The last-selected approval level persists across sessions (global state).
3. Policy changes via `/approval` apply immediately to in-flight tool calls and the next tool call — no waiting until the next prompt boundary.

## Acceptance Criteria

- Footer always shows the current approval level.
- A `/approval` change takes effect on the next tool call without a new prompt.
