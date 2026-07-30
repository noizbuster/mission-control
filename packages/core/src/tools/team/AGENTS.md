<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# team

## Purpose

Config-gated team-mode tool suite (`team_*`): lifecycle, messaging, query, and task-list tools plus on-disk team state store. Clean-room reimplementation against Mission Control persistence and tool registration. Default off (`team_mode.enabled`); factories return no registrations when disabled. Child surfaces hard-drop `team` capability.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Public barrel (`buildTeamToolRegistrations`, stores, schemas) |
| `team-registry.ts` | `buildTeamToolRegistrations`, `TEAM_TOOL_NAMES`, count |
| `team-context.ts` | Runtime/context, `teamModeEnabled`, spawn/IRC bridge types |
| `team-schemas.ts` | Zod/config schemas for team/member/task/mailbox |
| `team-store.ts` | Filesystem state/config/tasks/mailbox under team dir |
| `team-lifecycle-tools.ts` | create/delete/shutdown request/approve/reject |
| `team-messaging-tools.ts` | `team_send_message` |
| `team-query-tools.ts` | list/status |
| `team-task-tools.ts` | task create/get/list/update |
| `team-tools.test.ts` | Suite for gated registration and tool behavior |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Gate on `team_mode.enabled`; default empty registration list.
- Do not copy upstream expressions — keep clean-room boundary.
- `team` is hard-dropped on child/subagent surfaces (`buildChildToolSurface`).
- Persist via `team-store` paths; fail with `TeamStoreError` on corrupt/missing state.
- IRC bridge and member spawn go through injected `TeamToolRuntime` — tools stay thin.

### Testing Requirements

- `team-tools.test.ts` — focused vitest
- Cover disabled-by-default (zero tools) and enabled full set (`TEAM_TOOL_COUNT`)

### Common Patterns

- Twelve named tools assembled in registry; each factory self-gates on the same flag
- State files under per-team directory (`teamDir`)

## Dependencies

### Internal

- Parent tool registry patterns
- Persistence/path helpers as used by store
- Agents/runtime for member spawn when wired
- `@mission-control/protocol` / config for `team_mode`

### External

- Zod

<!-- MANUAL: -->
