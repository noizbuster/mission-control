<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# lib

## Purpose

Desktop client boundary and pure projection helpers: mock + Tauri `DesktopAgentClient`, Zod command/session schemas, session inspector projections/replay, redaction, and tool-call previews.

## Key Files

| File | Description |
|------|-------------|
| `agent-client.ts` | `DesktopAgentClient` interface; Tauri invoke wrapper; Zod-parse all responses |
| `agent-client-demo.ts` | Mock/demo client implementation (first-class scaffold) |
| `agent-client.test.ts` / `agent-client.tauri.test.ts` | Client boundary tests |
| `desktop-command-schemas.ts` | Zod schemas for command receipts/payloads |
| `desktop-session-schemas.ts` | Zod schemas for session snapshots/headers/events |
| `session-inspector.ts` | Inspector projection entry (timeline/graph/approval/patch/command views) |
| `session-inspector-session-detail.ts` | Session detail projection |
| `session-inspector-event-rows.ts` | Event row projection |
| `session-inspector-replay.ts` | Replay/run-state projection |
| `redaction.ts` | User-visible secret masking |
| `tool-call-preview.ts` | Tool-call preview formatting for UI |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Every Tauri payload crosses Zod here before UI render.
- Command name/payload changes must stay aligned with `src-tauri` handlers.
- Redaction applies to event text, approval previews, command output, credential-like strings.
- Keep demo client behavior intact for browser-only dev.

### Testing Requirements
- `agent-client*.test.ts`, `desktop-*-schemas.test.ts`, `session-inspector-*.test.ts`, awaiting-compat tests.
- Schema tests are the contract lock for native ↔ UI.

### Common Patterns
- Parse → project → redact pipeline; UI receives already-safe view models.
- Pure functions preferred for projections (easy unit tests).

## Dependencies

### Internal
- `@mission-control/protocol` — base event/session shapes where shared
- `@tauri-apps/api` — invoke from Tauri client path only

### External
- `zod`

<!-- MANUAL: -->
