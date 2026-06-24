# PRD: Build pipeline: stop nx TUI from blocking interactive `pnpm dev:cli`

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | nx configuration for the `dev` script |

## Background

`pnpm dev:cli` is interactive, but nx's TUI was spawning and stealing the terminal, breaking the interactive flow. The user asked whether to run the build entirely separately as an alternative.

## Goals

- `pnpm dev:cli` keeps the terminal interactive.

## Non-Goals

- (none stated)

## Requirements

1. `pnpm dev:cli` must remain interactive; nx TUI must not spawn and steal the terminal.
2. Decide and document: configure nx to bypass TUI for this target, or run build as a separate step.

## Acceptance Criteria

- Running `pnpm dev:cli` opens an interactive prompt without an nx TUI overlay.
