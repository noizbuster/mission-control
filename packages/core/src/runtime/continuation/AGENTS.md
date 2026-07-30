<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# continuation

## Purpose

Session-spanning continuation runtime. Wraps multiple `runGraph` invocations and persists continuation state between sessions on the boulder work entry. Distinct from graph-level `maxNodeRuns` (single execution bound): this bounds how many times a graph that signals `loop_active=true` may resume across session boundaries.

## Key Files

| File | Description |
|------|-------------|
| `continuation-runtime.ts` | `ContinuationRuntime` — `shouldContinue`, `advance`, `runWithContinuation`, `signalDone`, `persistState`/`loadState`, `ContinuationOutcome` |
| `continuation-runtime.test.ts` | Iteration bounds, done signal, loop_inactive, persist/load |
| `continuation-runtime-stop-race.test.ts` | Stop marker races vs in-flight advance |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- **Do not conflate** with `maxNodeRuns`. Continuation = cross-session resume bound via `maxIterations` + DONE signal.
- DONE detection is caller-delegated through `runGraphFn` → `{ done, loopActive, output }`. Runtime stays decoupled from exact signal mechanism.
- State key: `continuation_runtime` passthrough field on boulder work (schema `.passthrough()` so custom fields survive).
- **Do not** persist via `updateBoulderWork` if its patch type excludes custom fields — read/write boulder so passthrough survives (use `mutateBoulderWork` / direct boulder paths as implemented).
- `shouldContinue`: not stopped, `loopActive`, not `doneSignal`, `iteration < maxIterations`.
- Outcomes: `{ status: 'continue', sessionId, iteration }` or `{ status: 'done', iterations, reason }` where reason ∈ `done_signal` | `max_iterations` | `loop_inactive` | `stopped`.
- `ContinuationRuntimeError` carries a stable `code` for callers.

### Testing Requirements

- `continuation-runtime.test.ts`, `continuation-runtime-stop-race.test.ts`
- Package export smoke: `../../continuation-exports.test.ts` (core src root)
- Focused: `pnpm exec vitest run packages/core/src/runtime/continuation/<file>.test.ts`

### Common Patterns

- New session id per continue iteration; `lastSessionId` recorded on state.
- Stop marker (`RunnerStopMarker`) short-circuits continue even if loop still active.

## Dependencies

### Internal

- `../../persistence/boulder-store.ts` — `readBoulder`, `BoulderWork`, stop markers
- `../../persistence/boulder-work-mutation.ts` — `mutateBoulderWork`
- `zod` — `PersistedContinuationStateSchema`

### External

- `node:crypto` — session/work ids as needed

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
