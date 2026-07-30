<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

React desktop webview UI: app shell, provider controls, chat composer, session inspector, write-action hooks, and styles. All native I/O goes through `lib/agent-client.ts`.

## Key Files

| File | Description |
|------|-------------|
| `main.tsx` | React bootstrap / mount |
| `App.tsx` | Main shell: UI state, event log, provider controls, inspector wiring |
| `ChatComposer.tsx` | Composer UI for prompts/write flows |
| `ProviderControls.tsx` | Provider/model controls |
| `SessionInspector.tsx` | Session inspector shell |
| `SessionInspectorPanels.tsx` | Inspector list/summary panels |
| `SessionInspectorDetailPanels.tsx` | Detail panes (timeline/graph/approvals/patches/commands) |
| `SessionInspector.css` | Inspector-specific styles |
| `useDesktopWriteActions.ts` | Write/approval action hook → client + reload projections |
| `styles.css` | Global desktop styles |
| `vite-env.d.ts` | Vite client types |
| `App.test.tsx` / `App.*.test.tsx` | Shell, inspector, redaction, write-actions, event-log tests |
| `useDesktopWriteActions.test.ts` | Write-action hook tests |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `lib/` | Client boundary, Zod schemas, inspector projection, redaction (see `lib/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Do not import Tauri internals or read session files from components — use `lib/agent-client`.
- Preserve corrupt/missing/empty session inspector states (explicit tests).
- Redaction tests (`App.redaction.test.tsx`) are contracts for user-visible strings.

### Testing Requirements
- Colocated RTL/Vitest `*.test.tsx` beside components.
- Prefer mocking `DesktopAgentClient` over spinning Tauri.

### Common Patterns
- React function components; hooks for async client calls.
- After write/approve, reload inspector projections via client.

## Dependencies

### Internal
- `./lib/*` — client + schemas + projections
- `@mission-control/protocol` types via lib schemas

### External
- `react`, `react-dom`

<!-- MANUAL: -->
