# Runtime Agent Guide

## Overview

`packages/core/src/runtime` owns session run coordination: the `SessionRunOwner`, the run coordinator (queue/steer/resume/interrupt), the graph turn runner adapter, the bounded scheduler, the per-key drain-lane coordinator v2 with session-input delivery, the Mission/Run store, and the session-spanning continuation runtime. The original `run-coordinator.ts` handles interactive coding-agent runs; the v2 coordinator handles the workflow-path drain-lane.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Session run owner | `run-owner.ts` | `SessionRunOwner` — owns the tool registry, turn runner, durable event sink, provider envelope forwarding. |
| Run coordinator | `run-coordinator.ts`, `run-coordinator-lifecycle.ts` | Prompt admission, wake/run/resume/interrupt, drain loop, receipt settlement. |
| Coordinator types | `run-coordinator-types.ts` | `RunCoordinatorTurnRunner`, `SessionRunOwnerOptions`. |
| Per-key drain-lane coordinator v2 | `run-coordinator-v2.ts` | `RunCoordinatorV2` — coalesces `run`/`wake` demands per key, `interrupt` with seq suppression, `awaitIdle`, successor lanes on failure, demand coalescing via `coalesceDemand`. Native Promise/AbortController port of the opencode Effect drain-lane. |
| Session input delivery | `session-input-delivery.ts` | `SessionInputDelivery` — FIFO steer/queue admission (`admitInput`, `promoteSteers`, `promoteNextQueued`, `pendingSteerCount`/`pendingQueuedCount`). |
| Graph turn runner | `graph-coordinator-turn.ts` | `createGraphTurnRunner` — adapts `runAbgGraph` as a `RunCoordinatorTurnRunner`; seeds Blackboard from admitted conversation. |
| Bounded scheduler | `graph-coordinator-scheduler.ts` | Graph, provider-tool, and shell concurrency gates. |
| Mission/Run store | `mission-run/mission-store.ts`, `mission-run/run-store.ts` | JSON-per-record CRUD under `.omo/{missions,runs}/`. `mission-store.ts` (`createMission`/`readMission`/`updateMission`/`listMissions`), `run-store.ts` (`createRun`/`readRun`/`updateRunStatus`/`listRunsForMission`, `ALLOWED_RUN_TRANSITIONS`, `TERMINAL_RUN_STATUSES`, `assertRunTransition`). |
| Mission/Run service | `mission-run/mission-run-service.ts` | `materializeMission` (turns a `WorkflowSpec` into a `Mission`), `startRun` (two-phase `pending` then `running`), `completeRun`, `failRun`. Timestamps auto-managed; `RunPatch` excludes them. |
| Continuation runtime | `continuation/continuation-runtime.ts` | `ContinuationRuntime` (`runWithContinuation`, `shouldContinue`, `advance`, `signalDone`, `persistState`/`loadState`, `ContinuationOutcome`). Bounds session-spanning graph resume via `maxIterations` plus DONE signal; state persists in the boulder work `continuation_runtime` passthrough field. Distinct from graph-level `maxNodeRuns`. |

## Conventions

- The coordinator owns queue/steer/resume around whichever turn runner is installed.
- `haltOnFailedToolSettlement: true` terminates the run on the first non-approval, non-retryable tool failure.
- Tool registries are built by the CLI layer (`createInteractiveToolRegistry`/`createNonInteractiveToolRegistry`) and passed in — the runtime does NOT own tool registration.
- The graph turn runner seeds `initialMessages` from admitted conversation + threads approval decisions.
- `RunCoordinatorV2` is the workflow-path drain-lane; the original `run-coordinator.ts`/`run-coordinator-lifecycle.ts` stay for interactive coding-agent runs. Both coexist by design.
- Mission/Run records are single JSON files per record under `.omo/{missions,runs}/`, not append-only JSONL event logs. Run status transitions must go through `assertRunTransition` / `updateRunStatus` (pending → running → {blocked,completed,failed,cancelled}; blocked → running).
- `materializeMission` is a pure factory (no I/O). The caller persists via `createMission`; `startRun` reads the persisted mission by id.
- `ContinuationRuntime` bounds cross-session resume; `maxNodeRuns` bounds a single graph execution. Do not conflate the two.

## Tests

- `run-owner.ts` consumers: `apps/cli/src/commands/run-agent-owner-prompt.ts`, `interactive-coding-agent.ts`.
- Coordinator: `graph-coordinator-turn.test.ts`, `graph-coordinator.test.ts`.
- Drain-lane v2 + delivery: `run-coordinator-v2.test.ts` (covers `RunCoordinatorV2` and `SessionInputDelivery`).
- Mission/Run store + service: `mission-run/mission-run-service.test.ts`.
- Continuation runtime: `continuation/continuation-runtime.test.ts`.

## Anti-Patterns

- Do NOT bypass `scheduleQueuedNodes` for runnable nodes.
- Do NOT emit graph events without `graphId`, `sessionId`, timestamp.
- Do NOT let the SDK own the observe→decide→act loop — the graph (via `stopWhen: stepCountIs(1)`) always owns it.
- Do NOT persist continuation state via `updateBoulderWork`; its patch type excludes custom fields. Read and write the boulder directly so the `continuation_runtime` passthrough field survives.
- Do NOT set Run timestamps directly; `updateRunStatus` auto-manages `startedAt`/`endedAt`.
- Do NOT transition Run status without `assertRunTransition`; same-status transitions are idempotent no-ops, but illegal jumps must fail.
