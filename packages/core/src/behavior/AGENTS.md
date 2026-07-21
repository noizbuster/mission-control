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
| Node implementations | `nodes/`, `composite-nodes.ts`, `leaf-nodes.test.ts` | Deterministic scaffold node behavior. `parallel-static.ts` owns bounded static children; `parallel-fan-out.ts` owns blackboard-driven fan-out; `race-node.ts` owns process-local Race cleanup. |
| Tool advertising filter | `nodes/llm-actor/capability-expand.ts`, `llm-actor-node-helpers.ts` | OpenCode-style coarse→fine expand for node `capabilities` vs tool `capabilityClasses`. Advertising only — not approval. See `docs/tool-permission-model.md`. |

## Conventions

- The runtime is bounded and deterministic by default. Preserve max node runs, retry limits, loop protection, and concurrency caps.
- Rules are declarative predicates only. Do not add arbitrary JavaScript expression execution.
- Graph relationships are validated in protocol/core before execution: entry node, edge endpoints, rule references, and duplicate IDs.
- Use `AbgSignal` and protocol event metadata for graph output; do not invent local event shapes.
- Approval and policy blocks must emit observable lifecycle events, not silent booleans.
- Keep model metadata as observability/control data unless an implemented provider path is explicitly wired.
- An `llm` node with `outputKey` accepts only a whole exact structured representation. It does not parse a reasoning tail, select a last line, or invent a default when parsing fails.
- **Routing-key bi-coverage (LEVER B):** at `createAuthorableAbgGraph` / `materializeWorkflow`, every equals-routed structured llm `outputKey` MUST declare `outputEnum` (string labels) or `outputShape: 'boolean'`. Every `outputEnum` label MUST have a matching outbound equals edge from that node (or an unconditional outbound / `selectDefault` / `defaultTarget`). Every equals value for that key MUST be in the declared `outputEnum`. Non-structured writers (`implementation: 'critic'|'supervisor'|…`, parallel `verdictKey`, runtime keys like `llm.loop_active`) are exempt. See `routing-key-bi-coverage.ts`.
- **Recovery contract:** invalid structured admission → no `blackboard.set` → `invalid_structured_output` (retryable under budget) with correction payload (allowed labels + code). Conditional-only routing miss after success → durable `routing.dead_end`, re-admit under budget (tombstone the outputKey), then `failGraph('routing_dead_end')` or declared `escalationTarget` — never silent `graph.completed`. Correction is prepended once on the next attempt and cleared after productive success / escalate / failGraph.
- A static `parallel` node without `config.fanOutKey` runs declared `children` in waves. A positive integer `config.concurrency` selects its local bound, defaulting to 2; aggregate signals and child results remain in declaration order. A rejected child iterator emits failure and fails normal all-child completion.
- `fanOutKey` is a distinct blackboard-array path with a template child. Do not describe it as static `children` parallelism.
- `race` starts at most 4 children and rejects excess authoring before branch creation. It chooses the earliest valid completion within the current process. Cooperative branches drain through `.return()` during cleanup (5000ms default; positive integer `cleanupTimeoutMs` capped at 30000ms). Cleanup timeout, return rejection, or `next()`/pump rejection fails the Race even after a valid winner; ordinary child failure signals may lose without poisoning that winner. Arbitrary work is not forcibly terminated. Durable committed-order arbitration is deferred.

## Tests

- Validation and graph shape: `action-graph.test.ts`, `coding-agent-graph-fixtures.test.ts`, `routing-key-bi-coverage.test.ts` (LEVER B).
- Coordinator behavior: `graph-coordinator*.test.ts`, `watch-statechart-nodes.test.ts` (includes P1–P5 progress-contract pattern pack).
- Node registry and node behavior: `node-registry.ts`, `parallel-fan-out.test.ts`, `static-parallel.test.ts`, `selector.test.ts`, `join.test.ts`, `parallel-verdict.test.ts`, `nodes/race-node*.test.ts`, `leaf-nodes.test.ts`.
- Capability expand / tool advertising: `nodes/llm-actor/capability-expand.test.ts`.
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
- **Subagents + replay:** `../agents/task-tool-runtime-authority.ts` (`buildChildToolSurface`: category/tool allowlists, agent `pathPolicies`, depth-gated nested `task`, category-scoped network, hard drops, and invocation policy), `subagents/spawn-child.ts` (runs the supplied child surface), `replay/recorded-llm-replay.ts` (deterministic turn replay from recorded envelopes, ABG §7.5). `subagents/child-policy.ts` is retained only for deprecated simple-task compatibility filtering. See **Workflow subagent research path** below and `../agents/AGENTS.md` for the network matrix and `PRODUCTION_MAX_TASK_DEPTH`.
- **Event vocabulary** (emit `event.type` strings): `llm.turn.started`, `llm.text.delta`, `llm.reasoning.delta`, `llm.tool_call.proposed`, `llm.turn.completed`, `llm.error`, `tool.started`/`tool.completed`/`tool.failed`/`tool.denied`, `policy.evaluated`, `context.packed`, `critic.evaluated`. These are free-form emit types (not the `AgentEventType` enum); the projection in `signals.ts` maps the signal `type` to the durable `AgentEvent` type.

**Hard constraint (pre-mortem #4):** every `streamText` in `runLlmActor` pins `stopWhen: stepCountIs(1)` — the graph, never the SDK, owns the observe→decide→act loop.

## Deferred per-phase items — delivered (plan §16)

- **Cost ledger (`budget/cost-ledger.ts`):** `CostLedger` prices each turn's usage against an
  operator-supplied `PricingTable` and emits `policy.budget.accumulated`/`.warning`/`.exceeded`.
  Threaded as `AbgNodeRunContext.budgetLedger` (coordinator builds it from
  `graph.defaults.model.budgetCents` + `AbgGraphRunnerInput.pricingTable`). Pricing is
  operator-supplied (`DEFAULT_PRICING = []`) — no stale list prices ship.
- **Supervisor node (`nodes/supervisor-node.ts`, `implementation: 'supervisor'`):** retry-vs-
  escalate with exponential backoff. Backoff is COMPUTED + emitted as data
  (`supervisor.backoff`/`supervisor.evaluated`); never slept. Escalates via the Phase-1
  `escalate` signal once `maxAttempts` is exhausted.
- **Speculative node (`nodes/speculative-node.ts`, `implementation: 'speculative'`):**
  concurrent branch drain with join-rank (`rankBy: 'score'|'first'`) + early-stop
  (`stopThreshold`). Losers are abandoned via `.return()` on early-stop.
- **`task` tool + child spawn (`tools/task-tool.ts`, `subagents/spawn-child.ts`):** the `task`
  tool delegates to an injected `spawn` fn; `spawnChildCodingAgent` builds a child coding-agent
  run from a caller-supplied child registry. The full-parity path uses `buildChildToolSurface` to
  omit `task`/`job` (unless depth-allowed nesting), hard-drop `workflow`/`team`, hard-drop
  `subagent` unless depth-allowed, hard-drop `network` unless category/agent is in
  `CHILD_NETWORK_ALLOWED_CATEGORIES`, add `yield`, and install category plus derived path-policy
  invocation checks. Destructive tools remain policy-controlled. Bounded nesting only
  (`PRODUCTION_MAX_TASK_DEPTH=3`); not unlimited recursion and not OMC free recursion.
- **`lsp`/`mcp` tools (`tools/lsp-tool.ts`, `tools/mcp-tool.ts`):** client-seam tools
  (`LspClient`/`McpClient`) with in-process clients for tests; real stdio/JSON-RPC transport
  sits behind the seam.
- **Event-id determinism (`abg-emit.ts`):** per-`graphId` counter + `resetEmitSequence` at run
  start → sequential runs are byte-identical. Persisted ids are store-minted UUIDs (unaffected).
- **SQLite store (`memory/sqlite-persistent-store.ts`):** `SqlitePersistentStore` over an
  operator-supplied `better-sqlite3` (dynamic import; ambient types in `better-sqlite3.d.ts`).
  NOT a manifest dep (dependency-guarded); `InMemoryPersistentStore` stays the default.
- **Mission/Run schemas (`protocol/mission-run.ts`):** `Mission` (agent definition) + `Run`
  (execution instance) Zod schemas.

**Still deferred (larger engineering, needs explicit approval):** per-adapter SSE-parsing
deletion (the risky final cutover — delete only after the CLI defaults to the graph + e2e
verified); full Inspector UI surfaces (separate app package).

## Workflow subagent research path

Built-in workflow graphs advertise `task()` and network on specific research parents. Child
network is category-scoped and nested depth is capped in `../agents/` (not by stripping every child of both).

### Research parents (`read` + `subagent` + `network` + `bash`)

These llm nodes keep capabilities exactly `['read', 'subagent', 'network', 'bash']` so they can read
the workspace, call `task()`, use parent-side `webfetch` / `web_search` / `mcp__*` when advertised,
and run read-only bash (git log, rg, find, ls, cat, pnpm list, etc.) for direct exploration without
forcing a `task()` round-trip. They do **not** get write/edit/patch — bash is for read-only inspection
and every invocation still goes through the approval gate (`permission profile` default `ask`):

| Workflow | Node ids | Factory |
| --- | --- | --- |
| `default` / `fixer` exploratory branch | `research-explore` | `fixer-workflow-graph.ts` (default wraps fixer) |
| `planner` clear path | `explore` | `planner-workflow-graph.ts` |
| `planner` unclear path | `research` | `planner-workflow-graph.ts` |

The `default` / `fixer` graph also exposes `['read', 'bash']` on `maturity-sample` (sampling benefits
from `git log` / `pnpm list` / `rg`) and on `evidence-check` (whose prompt already demanded
`lsp_diagnostics` / build / test verification that was previously unreachable without tools).

Soft prompt bias (not topology): prefer `explore` / `librarian` children for read-only breadth;
route external docs/web lookup via `librarian` (or `deep` / `reasoner` / `oracle` / `designer`
when the parent chooses those categories). Shared text: `readonly-task-child-context.ts`.
Do not list `category:"deep"` as a preferred read-only route on those parents.

Planner dual-reviewer / oracle nodes stay `['subagent']` only (no parent network on those
lanes). Planner-readonly mode has empty `requiredTools`, so materialize does not strip
`subagent`/`network`/`bash` from explore/research. The mode's `systemPromptOverlay` explicitly
forbids using bash to mutate files; the per-node prompts repeat that constraint. The mode's
write-deny policies continue to govern file mutations independently of bash.

### Child network matrix (category-scoped)

Child `network` is **not** universally denied. `network` stays in
`CHILD_HARD_DROPPED_CAPABILITY_KINDS`; the allowlist is a filter-time exception via
`allowNetworkCapability` / `CHILD_NETWORK_ALLOWED_CATEGORIES` in `../agents/child-graph-spawn.ts`:

- **ON** (may retain parent `webfetch` / `web_search` / `mcp__*`): `librarian`, `deep`,
  `reasoner`, `oracle`, `designer`, `planner`
- **OFF** (network hard-dropped): `explore`, `reviewer`, `quick`

Webfetch claims apply only on ON paths (and on research parents that declare `network`).

### Nested `task` depth

Production nesting uses only `PRODUCTION_MAX_TASK_DEPTH = 3` in `../agents/recursion-policy.ts`:
spawn while `taskDepth < 3` (depths 0/1/2 may keep nested `task`); depth 3 is the blocked leaf
(MAIN → d1 → d2 → d3). Still no unlimited recursion; `AgentDefinition.recursion` and
`DEFAULT_MAX_RECURSION_DEPTH` (compat, value 2) cannot raise the live cap. Not OMC free
recursion.

### Executer F1–F4 dual-review hybrid

`executer-workflow-graph.ts` final wave: each of f1–f4 is an llm critic with
`capabilities: ['subagent']` and `outputEnum: ['APPROVE', 'REJECT']`. Soft prompt bias asks
for `task(reviewer)` then a whole-output verdict. `final-verification-wave` still aggregates
via `verdictStrategy: 'all-approve'` / `aggregateFinalVerdict` into string `final.verdict`.

- F1 goal, F2 constraints, F3 tests-as-claims (evidence only; **no bash** / no self-run suite),
  F4 code quality.
- Critics do not declare `bash`, `read`, or `network`. Do not document F3 as running tests.
