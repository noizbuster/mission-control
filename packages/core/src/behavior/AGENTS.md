<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# behavior

## Purpose

Bounded Authorable ABG/action-graph runtime: graph validation, node registry, coordinator scheduling, approval gates, signals/timeline projection, coding-agent Observe→Decide→Act loop, workflow graphs (default/fixer/planner/executer), modes, budgets, subagent spawn, and recorded LLM replay.

## Key Files

| File | Description |
|------|-------------|
| `action-graph.ts` | Legacy simple action-graph validation + clone-on-create |
| `authorable-graph.ts` | Authorable graph validation via protocol schemas + model defaults |
| `graph-runner.ts` | `runAbgGraph` facade — bounded execution + result status |
| `graph-coordinator.ts` | Core coordinator loop, re-entry, result handling |
| `graph-coordinator-scheduler.ts` | Graph / provider-tool / shell concurrency gates |
| `graph-coordinator-node-runner.ts` | Registry dispatch + node result handling |
| `graph-coordinator-node-execution.ts` | Node execution plumbing |
| `graph-coordinator-node-signals.ts` | Signal fan-out from node results |
| `graph-coordinator-resume.ts` | Graph resume / checkpoint re-entry |
| `graph-coordinator-run-context.ts` | Per-run context bag for nodes |
| `graph-coordinator-helpers.ts` | Shared coordinator helpers |
| `graph-coordinator-progress-contract.ts` | Progress-contract enforcement (P1–P5) |
| `graph-approval-gates.ts` | Permission/approval lifecycle events |
| `graph-checkpoint-emit.ts` | Checkpoint emission helpers |
| `graph-runner-events.ts` | Runner event projection |
| `graph-state.ts` | Graph runtime state shapes |
| `node-registry.ts` | Scaffold/mock node registry (fixtures, flat-loop) |
| `coding-agent-graph.ts` | Real coding-agent graph (llm-actor self-edge on `llm.loop_active`) |
| `coding-agent-registry.ts` | Real node runners — separate from mock registry |
| `signals.ts` | `AbgSignal` → durable `AgentEvent` projection |
| `timeline.ts` | Timeline row projection |
| `abg-emit.ts` | Deterministic per-`graphId` emit sequence + `resetEmitSequence` |
| `structured-blackboard.ts` | Typed blackboard get/set |
| `routing-key-bi-coverage.ts` | LEVER B: equals-routed llm `outputKey` ↔ `outputEnum` bi-coverage |
| `routing-completeness.ts` | Routing completeness validation |
| `correction-payload.ts` | Invalid structured-output correction payloads |
| `loop-safety.ts` | Loop / max-run protection helpers |
| `rule-compiler.ts` | Declarative rule predicate compilation |
| `failure-taxonomy.ts` | Failure classification + inspect helpers |
| `checkpoint-blackboard-snapshot.ts` | Blackboard snapshot for checkpoints |
| `behavior-node.ts` | Thin behavior-node type re-export |
| `agent-model-resolver.ts` | Graph-level agent model resolution |
| `builtin-workflows.ts` | Builtin workflow registration surface |
| `default-workflow-graph.ts` | Default workflow graph factory |
| `fixer-workflow-graph.ts` | Fixer / exploratory research branch |
| `planner-workflow-graph.ts` | Planner dual-path + dual-reviewer graph |
| `executer-workflow-graph.ts` | Executer F1–F4 dual-review hybrid |
| `executer-plan-admission.ts` | Plan admission for executer |
| `planner-dual-review.ts` | Planner dual-review helpers |
| `planner-interview.ts` | Planner interview stage |
| `planner-metis.ts` | Metis reject-gate integration |
| `readonly-task-child-context.ts` | Soft prompt bias for readonly `task()` children |
| `delegate-worker-yield-retry.ts` | Delegate worker yield retry helper |
| `composite-node-test-helpers.ts` | Shared composite node test utils |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `budget/` | Cost ledger + node-run budget extension (see `budget/AGENTS.md`) |
| `modes/` | Mode overlays (`autopilot`, `applyMode`) (see `modes/AGENTS.md`) |
| `nodes/` | Node implementations including llm-actor (see `nodes/AGENTS.md`) |
| `replay/` | Recorded LLM turn replay (see `replay/AGENTS.md`) |
| `subagents/` | Child coding-agent spawn (see `subagents/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Runtime is bounded/deterministic: preserve max node runs, retries, loop protection, concurrency caps.
- Rules are declarative predicates only — no arbitrary JS expression execution.
- Validate entry node, edge endpoints, rule refs, duplicate IDs before execution.
- Use `AbgSignal` + protocol event metadata; do not invent local event shapes.
- Approval/policy blocks must emit observable lifecycle events.
- **Hard constraint:** every `streamText` in `runLlmActor` pins `stopWhen: stepCountIs(1)` — the graph owns the loop, never the SDK.
- **LEVER B:** every equals-routed structured llm `outputKey` MUST declare `outputEnum` or `outputShape: 'boolean'`; every label needs a matching outbound equals edge (or unconditional/`selectDefault`/`defaultTarget`).
- **Recovery:** invalid structured admission → no `blackboard.set` → `invalid_structured_output` (retryable) with correction; routing miss → `routing.dead_end` then fail/escalate — never silent `graph.completed`.
- Static `parallel` without `fanOutKey` runs declared `children`; `fanOutKey` is blackboard-array template fan-out — distinct paths.
- `race` ≤ 4 children; cooperative `.return()` cleanup (default 5000ms, cap 30000ms).
- Mock registry (`node-registry.ts`) stays for fixtures; real runners live in `coding-agent-registry.ts` (strangler-fig).
- When example graph behavior changes, update `examples/abg/*.graph.json` and root ABG contract tests.

### Testing Requirements

- Validation: `action-graph.test.ts`, `coding-agent-graph-fixtures.test.ts`, `routing-key-bi-coverage.test.ts`
- Coordinator: `graph-coordinator*.test.ts`, `watch-statechart-nodes.test.ts`
- Nodes: `parallel-fan-out.test.ts`, `static-parallel.test.ts`, `selector.test.ts`, `join.test.ts`, `parallel-verdict.test.ts`, `leaf-nodes.test.ts`
- Workflows: `*-workflow-*.test.ts`, `planner-*.test.ts`, `executer-*.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/behavior/<file>.test.ts`

### Common Patterns

- `enqueueSelectedTargets` feeds `lastEventType` / live blackboard / `lastPolicyDecision` into rule eval (concurrency-safe).
- Event vocabulary (free-form emit types): `llm.turn.*`, `llm.text.delta`, `llm.tool_call.proposed`, `tool.*`, `policy.evaluated`, `context.packed`, `critic.evaluated`.
- Research parents (`read`+`subagent`+`network`+`bash`): fixer `research-explore`; planner `explore`/`research`. No write/edit/patch on those nodes.
- Child network matrix and `PRODUCTION_MAX_TASK_DEPTH` live in `../agents/` — see `../agents/AGENTS.md`.
- Executer F1–F4 critics: `capabilities: ['subagent']`, `outputEnum: ['APPROVE','REJECT']`; F3 is evidence-only (no bash).

## Dependencies

### Internal

- `@mission-control/protocol` — ABG graph/signal/mission schemas
- `../agents/` — child tool surface, recursion, network allowlist
- `../tools/` — tool registry consumed by llm-actor / tool-actor
- `../providers/` — AI SDK bridge, retry, redaction
- `../context/` — system prompt assembly for llm-actor
- `../runtime/` — session control epoch for child spawn
- `../persistence/` — boulder/plan stores used by draft-frontmatter nodes

### External

- `ai` (Vercel AI SDK) — `streamText` / `generateText` via llm-actor
- `zod` — structured output / schema paths

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
