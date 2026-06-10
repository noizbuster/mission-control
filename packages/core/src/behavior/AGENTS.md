# Behavior Graph Agent Guide

## Overview

`packages/core/src/behavior` owns the bounded Authorable ABG/action-graph runtime: graph validation, node registry, scheduling, approval gates, node execution, signals, and timeline/snapshot projection.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Simple action graph validation | `action-graph.ts` | Legacy graph shape, clone-on-create behavior. |
| Authorable graph validation | `authorable-graph.ts` | Uses protocol graph schemas and model defaults. |
| Graph runner facade | `graph-runner.ts`, `graph-coordinator.ts` | Bounded execution loop and result status. |
| Scheduling and limits | `graph-coordinator-scheduler.ts` | Graph, provider-tool, and shell concurrency gates. |
| Node execution | `graph-coordinator-node-runner.ts`, `node-registry.ts` | Registry dispatch and node result handling. |
| Approval gates | `graph-approval-gates.ts` | Permission and approval lifecycle events. |
| Signals and events | `signals.ts`, `graph-runner-events.ts`, `timeline.ts` | Projection into protocol events and timeline rows. |
| Node implementations | `nodes/`, `composite-nodes.ts`, `leaf-nodes.test.ts` | Deterministic scaffold node behavior. |

## Conventions

- The runtime is bounded and deterministic by default. Preserve max node runs, retry limits, loop protection, and concurrency caps.
- Rules are declarative predicates only. Do not add arbitrary JavaScript expression execution.
- Graph relationships are validated in protocol/core before execution: entry node, edge endpoints, rule references, and duplicate IDs.
- Use `AbgSignal` and protocol event metadata for graph output; do not invent local event shapes.
- Approval and policy blocks must emit observable lifecycle events, not silent booleans.
- Keep model metadata as observability/control data unless an implemented provider path is explicitly wired.

## Tests

- Validation and graph shape: `action-graph.test.ts`, `coding-agent-graph-fixtures.test.ts`.
- Coordinator behavior: `graph-coordinator*.test.ts`, `watch-statechart-nodes.test.ts`.
- Node registry and node behavior: `node-registry.ts`, `composite-nodes.test.ts`, `leaf-nodes.test.ts`.
- When example graph behavior changes, update `examples/abg/*.graph.json` and root ABG/readme contract tests as needed.

## Anti-Patterns

- Do not bypass `scheduleQueuedNodes` for runnable nodes; it enforces resource limits.
- Do not emit graph events without `graphId`, `sessionId`, timestamp, and ABG metadata.
- Do not hide approval denial as graph failure unless the tested lifecycle requires it.
- Do not turn the scaffold into a full production ABG engine without explicit scope.
