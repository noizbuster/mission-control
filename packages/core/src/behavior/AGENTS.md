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

## Coding-agent graph + extended vocabulary (Phases 1–9)

Beyond the scaffold above, the behavior package now hosts the **real** coding-agent runtime:

- **Graph + registry:** `coding-agent-graph.ts` (Observe→Decide→Act loop; `llm-actor` self-edge gated by `blackboard.value.equals llm.loop_active`), `coding-agent-registry.ts` (real node runners in a SEPARATE registry — the mock registry still serves fixtures/flat-loop, strangler-fig).
- **Real nodes:** `nodes/llm-actor/` (`runLlmActorNode` = graph↔AI-SDK bridge, pins `stopWhen: stepCountIs(1)` so the GRAPH owns the loop), `nodes/tool-actor-node.ts`, `nodes/memory-node.ts`, `nodes/policy-gate-node.ts` (3-state, emits `policy.evaluated`), `nodes/human-approval-node.ts`, `nodes/critic-node.ts` (Draft→Critic→QualityGate, sets `critic.passed`).
- **Coordinator re-entry:** `enqueueSelectedTargets` feeds the node's `lastEventType` / live `blackboard` / `lastPolicyDecision` into rule evaluation (carried per-result, concurrency-safe), so runtime-condition edges fire. `escalate`/`fallback` signals + `node.escalated`/`node.fallback` events exist.
- **Subagents + replay:** `subagents/child-policy.ts` (child allow-list minus destructive kinds), `replay/recorded-llm-replay.ts` (deterministic turn replay from recorded envelopes, ABG §7.5).
- **Event vocabulary** (emit `event.type` strings): `llm.turn.started`, `llm.text.delta`, `llm.reasoning.delta`, `llm.tool_call.proposed`, `llm.turn.completed`, `llm.error`, `tool.started`/`tool.completed`/`tool.failed`/`tool.denied`, `policy.evaluated`, `context.packed`, `critic.evaluated`. These are free-form emit types (not the `AgentEventType` enum); the projection in `signals.ts` maps the signal `type` to the durable `AgentEvent` type.

**Hard constraint (pre-mortem #4):** every `streamText` in `runLlmActor` pins `stopWhen: stepCountIs(1)` — the graph, never the SDK, owns the observe→decide→act loop.

