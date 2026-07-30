<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# mission-run

## Purpose

Authoritative durable Mission/Run SQL stores and orchestration service in `mission-control.db`. `mission_runs` owns Run state; JSONL is only the linked session timeline and replay/import/export compatibility format. Store-owned `.mc/{missions,runs}/*.json` reads remain separate compatibility data. Service materializes Missions from WorkflowSpecs and drives Run lifecycle transitions.

## Key Files

| File | Description |
|------|-------------|
| `mission-run-service.ts` | `materializeMission`, `startRun`, `blockRun`, `cancelRun`, `completeRun`, `failRun` |
| `mission-store.ts` | `createMission` / `readMission` / `updateMission` / `listMissions` |
| `run-store.ts` | `createRun` / `readRun` / `updateRunStatus` / `listRunsForMission`, transition helpers |
| `run-status-transitions.ts` | `ALLOWED_RUN_TRANSITIONS`, `TERMINAL_RUN_STATUSES`, `assertRunTransition` |
| `mission-run-db.ts` | DB access helpers for mission/run tables |
| `mission-run-store-location.ts` | Store location normalization |
| `run-session-owner-store.ts` | Run↔session owner attachment + settlement |
| `run-session-owner-authority.ts` | Owner authority checks |
| `failed-run-store.ts` | Failed-run persistence helpers |
| `run-json-compatibility.ts` | `.mc/runs/*.json` compatibility reads |
| `run-persistence-sanitization.ts` | Sanitize patches before persist |
| `compat-record-reader.ts` | Compat record reader utilities |
| `mission-run-test-support.ts` | Shared test doubles/fixtures |
| `*.test.ts` | Service, stores, transitions, import authority, session lifecycle |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- **SQL is authoritative** for Mission/Run. JSONL never owns Run state. `.mc/{missions,runs}/*.json` is compatibility-only via owning store readers.
- `materializeMission` is a **pure factory** (no I/O). Caller persists via `createMission`; `startRun` reads persisted mission by id.
- `startRun`: two-phase `pending` then `running`; may link session + persist initiating `prompt` for `/retry`; mission → `active`.
- Transitions (must use `assertRunTransition` / `updateRunStatus`):
  - pending → {running, cancelled}
  - running → {blocked, completed, failed, cancelled}
  - blocked → {running, cancelled}
- Same-status transitions are idempotent no-ops; illegal jumps fail.
- `blocked` nonterminal/resumable; `cancelled` terminal + `terminalReason`; `endedAt`/`startedAt` auto-managed — never set timestamps directly in patches.
- `RunPatch` excludes timestamp fields by design.
- Import paths must respect owner authority (`run-import-authority` tests).

### Testing Requirements

- `mission-run-service.test.ts`, `mission-store.test.ts`, `run-store.test.ts`
- `run-store-session-lifecycle.test.ts`, `run-session-owner-store.test.ts`
- `failed-run-store.test.ts`, `mission-materialization.test.ts`, `mission-run-location.test.ts`
- `run-import-authority.test.ts`
- Package export smoke: `../../mission-run-exports.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/runtime/mission-run/<file>.test.ts`

### Common Patterns

- Cost on complete is caller-accumulated replacement via `RunCompletionInput.cost`.
- Session control attachments tracked for settlement on terminal transitions.
- Capabilities derived from workflow category permission union; mode declarations from active mode bindings; policies inherited from graph ABG policies.

## Dependencies

### Internal

- `@mission-control/protocol` — `Mission`, `Run`, `WorkflowSpec`, schemas
- `../session-control-host.ts` — attachment types
- `../../db/` / mission-control.db access patterns via `mission-run-db.ts`
- `../../persistence/` — JSON compatibility file helpers where used

### External

- `node:crypto` — `randomUUID` for mission/run ids

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
