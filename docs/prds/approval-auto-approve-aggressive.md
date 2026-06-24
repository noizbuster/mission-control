# PRD: Approval system: auto-approve `command.run` under aggressive level

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Approval level semantics (`approval-level.ts`), `command.run` gating |

## Background

`command.run` was not auto-approving at the user's intended level. The user clarified the level name is `aggressive`, not `auto` — `aggressive` is the level at which command.run should auto-approve.

## Goals

- `command.run` auto-approves under `aggressive` (not `auto`).

## Non-Goals

- Changing yolo semantics.

## Requirements

1. Under approval level `aggressive`, `command.run` auto-approves without prompting.
2. The level name is `aggressive` (not `auto`); documentation and code use this name consistently.
3. Yolo semantics are unchanged.

## Acceptance Criteria

- At `aggressive` level, a `command.run` tool call does not produce an approval prompt.
