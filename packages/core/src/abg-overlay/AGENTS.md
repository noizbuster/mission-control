<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# abg-overlay

## Purpose

ABG UI overlay state module: single projector exporting `AbgOverlayState` / draft, external store, and pure projectors that fold agent/graph events into graph summaries, node status, tool outcomes, approvals, blackboard snapshot, token/cost counters, and run state for TUI/desktop consumers.

## Key Files

| File | Description |
|------|-------------|
| `state.ts` | State shape, draft, store, projectors (SIZE_OK indivisible module) |
| `index.ts` | Re-exports `./state` |
| `state.test.ts` | Projector/store coverage |
| `state-usage-emit.test.ts` | Usage/cost emit projections |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Keep as one module — plan requires tightly coupled projectors to share this path; do not split casually.
- Published snapshots stay readonly; mutators receive `AbgOverlayDraft` then publish.
- Redact credential-like text via `../providers/credential-resolver` when projecting messages.
- Derive UI state from events; do not invent hidden mutable run authority here.

### Testing Requirements

- `state.test.ts`, `state-usage-emit.test.ts`

### Common Patterns

- Event in → pure fold → store snapshot out
- Maps for nodes/graphs/blackboard; capped recent event list

## Dependencies

### Internal

- `@mission-control/protocol` — ABG/agent event types
- `../providers/credential-resolver` — redaction

### External

- None beyond TS std

<!-- MANUAL: -->
