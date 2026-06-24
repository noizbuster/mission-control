# PRD: Build pipeline: fix core build failures and add dev:cli pre-build hook

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | `pnpm dev:cli` script, `core:build` target, nx task graph |

## Background

Recurring `core build` failures were blocking work, and `pnpm dev:cli` was launching the CLI without building first, so stale dist could be executed.

## Goals

- `core build` succeeds reliably.
- `pnpm dev:cli` builds core (and upstream) before launching the CLI.

## Non-Goals

- (none stated)

## Requirements

1. Investigate and fix recurring `core build` failures.
2. `pnpm dev:cli` must run the build (core + any upstream) before launching the CLI.

## Acceptance Criteria

- `core build` exits 0 on a clean tree.
- `pnpm dev:cli` produces fresh dist before the CLI process starts.
