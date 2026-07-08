# PRD: Historical TUI library migration and drift audit

| Field | Value |
| --- | --- |
| Status | superseded by OpenTUI implementation |
| Scope | Historical interactive CLI shell migration, current OpenTUI shell (`apps/tui/src/create-chat-tui.tsx`), and the non-TTY terminal fallback path |
| Related plans | `.omo/plans/ink-migration.md` |

## Background

The original design spec named Ink as the TUI library for the interactive shell, but that migration target has since been superseded by the current OpenTUI implementation. The drift-audit requirement still applies: every technology named in the docs should be checked against what the code actually uses, so silent drift does not accumulate.

## Goals

- OpenTUI is the documented TUI library for the interactive CLI shell.
- Every documented technology is actually applied where the docs claim it is.

## Non-Goals

- Removing the non-TTY terminal fallback path (intentionally kept for tests).
- Changing the ChatStore single-source-of-truth contract.

## Requirements

1. Audit every documented technology in AGENTS.md and README against the actual implementation and produce a drift report.
2. Identify interactive shell code paths that bypass OpenTUI-managed input or the `useSyncExternalStore` render contract.
3. Produce a migration plan that keeps legacy terminal code off the OpenTUI input + render path.
4. The migration preserves the non-TTY fallback path used by tests.
5. The migration preserves the ChatStore single-source-of-truth contract: React components are read-only views of the snapshot and never mutate core state directly.

## Acceptance Criteria

- Drift report exists and covers every documented technology.
- No interactive shell path bypasses OpenTUI input handling or `useSyncExternalStore` after migration.
