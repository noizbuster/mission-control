# Runtime Agent Guide

## Overview

`packages/core/src/runtime` owns session run coordination: the `SessionRunOwner`, the run coordinator (queue/steer/resume/interrupt), the graph turn runner adapter, and the bounded scheduler.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Session run owner | `run-owner.ts` | `SessionRunOwner` — owns the tool registry, turn runner, durable event sink, provider envelope forwarding. |
| Run coordinator | `run-coordinator.ts`, `run-coordinator-lifecycle.ts` | Prompt admission, wake/run/resume/interrupt, drain loop, receipt settlement. |
| Coordinator types | `run-coordinator-types.ts` | `RunCoordinatorTurnRunner`, `SessionRunOwnerOptions`. |
| Graph turn runner | `graph-coordinator-turn.ts` | `createGraphTurnRunner` — adapts `runAbgGraph` as a `RunCoordinatorTurnRunner`; seeds Blackboard from admitted conversation. |
| Bounded scheduler | `graph-coordinator-scheduler.ts` | Graph, provider-tool, and shell concurrency gates. |

## Conventions

- The coordinator owns queue/steer/resume around whichever turn runner is installed.
- `haltOnFailedToolSettlement: true` terminates the run on the first non-approval, non-retryable tool failure.
- Tool registries are built by the CLI layer (`createInteractiveToolRegistry`/`createNonInteractiveToolRegistry`) and passed in — the runtime does NOT own tool registration.
- The graph turn runner seeds `initialMessages` from admitted conversation + threads approval decisions.

## Tests

- `run-owner.ts` consumers: `apps/cli/src/commands/run-agent-owner-prompt.ts`, `interactive-coding-agent.ts`.
- Coordinator: `graph-coordinator-turn.test.ts`, `graph-coordinator.test.ts`.

## Anti-Patterns

- Do NOT bypass `scheduleQueuedNodes` for runnable nodes.
- Do NOT emit graph events without `graphId`, `sessionId`, timestamp.
- Do NOT let the SDK own the observe→decide→act loop — the graph (via `stopWhen: stepCountIs(1)`) always owns it.
