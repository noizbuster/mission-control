# PRD: TUI prompt history: arrow-key recall with continuous advancement

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Input history navigation (`input-history-store.ts`, arrow-key handling in `handleInput`) |
| Related plans | `.omo/plans/model-picker-input-system-fix.md` |

## Background

Arrow-up history navigation only moved one entry per press and required re-pressing to advance, regressing against the expected semantics where consecutive arrow presses walk back through history fluidly without intermediate commit presses.

## Goals

- Arrow-key history recall advances fluidly on consecutive presses.

## Non-Goals

- (none stated)

## Requirements

1. Arrow-up recalls the previous prompt.
2. An immediate second arrow-up advances to the prior entry (no intermediate commit press required).
3. A single physical press advances exactly one entry; no extra press is needed to "commit" the current entry before advancing.

## Acceptance Criteria

- Holding or rapidly pressing arrow-up walks back through history entries at a fluid cadence with no extra commit presses.
