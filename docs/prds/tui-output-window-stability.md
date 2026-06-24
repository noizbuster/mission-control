# PRD: TUI output window: prevent irregular content loss during runs

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Output text accumulation, `selectTrailingBlocks` window budget, Ink re-render loop |

## Background

During runs the output window content was disappearing irregularly, wiping context the user needed.

## Goals

- Output window content never disappears unexpectedly during a run.

## Non-Goals

- Removing the trailing-window budget.

## Requirements

1. Output window content must not disappear irregularly during an active run.
2. Truncation may drop old blocks but must never wipe the current assistant response.
3. The trailing-window budget behavior is preserved (only its unintended wipe behavior is fixed).

## Acceptance Criteria

- A long-running prompt does not clear previously-rendered output blocks except via the documented window budget.
