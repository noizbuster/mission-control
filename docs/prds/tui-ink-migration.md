# PRD: Ink TUI library: full adoption and migration of legacy terminal code

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Interactive CLI shell (`apps/cli/src/commands/ink-chat-bridge.tsx`) and the non-Ink terminal fallback path |
| Related plans | `.omo/plans/ink-migration.md` |

## Background

The original design spec named Ink as the TUI library for the interactive shell, but parts of the implementation had drifted away from Ink-managed input and rendering. A broader audit was also requested: every technology named in the docs should be checked against what the code actually uses, so silent drift does not accumulate.

## Goals

- Ink is the single TUI library for the interactive CLI shell.
- Every documented technology is actually applied where the docs claim it is.

## Non-Goals

- Removing the non-TTY terminal fallback path (intentionally kept for tests).
- Changing the bridge-core single-source-of-truth contract.

## Requirements

1. Audit every documented technology in AGENTS.md and README against the actual implementation and produce a drift report.
2. Identify interactive shell code paths that bypass Ink-managed input (`useInput`) or Ink-managed rendering (`useSyncExternalStore`).
3. Produce a migration plan that brings legacy terminal code onto Ink's input + render contract.
4. The migration preserves the non-TTY fallback path used by tests.
5. The migration preserves the bridge-core single-source-of-truth contract: React components are read-only views of the snapshot and never mutate core state directly.

## Acceptance Criteria

- Drift report exists and covers every documented technology.
- No interactive shell path bypasses `useInput` / `useSyncExternalStore` after migration.
