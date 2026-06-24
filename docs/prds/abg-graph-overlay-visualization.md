# PRD: ABG overlay: per-node colored state labels and active-node spinner

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | ABG overlay panes (`AbgOverlay.tsx`, `AbgOverlayPanesA.tsx`, `AbgOverlayPanesB.tsx`) |

## Background

The ABG overlay pane showed the node list without per-node current state, and active nodes had no spinner.

## Goals

- Per-node colored state labels.
- Spinner on the active node.

## Non-Goals

- Introducing a new graph layout engine.

## Requirements

1. Each graph node shows a colored, bracketed current-state label (e.g., `[running]`, `[completed]`).
2. The active node shows a spinner aligned with the existing AgentSpinner cadence.

## Acceptance Criteria

- Every node in the overlay has a visible state label.
- The currently-running node shows an animated spinner.
