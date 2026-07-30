<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# nodes

## Purpose

ABG node implementations for the coding-agent and workflow registries: composites (parallel/race/selector/join), policy/human/resume gates, critic/supervisor/speculative/verification nodes, tool-actor, memory, draft-frontmatter, dual-review helpers, and the llm-actor subtree (AI-SDK bridge).

## Key Files

| File | Description |
|------|-------------|
| `leaf-nodes.ts` | Deterministic scaffold leaf implementations |
| `composite-nodes.ts` | Composite node wiring helpers |
| `composite-node-utils.ts` | Shared composite utilities |
| `parallel-static.ts` | Static `children` waves; local concurrency default 2 |
| `parallel-fan-out.ts` | Blackboard-array `fanOutKey` template fan-out |
| `parallel-verdict.ts` | Verdict aggregation (`all-approve`, etc.) |
| `race-node.ts` | Race ≤4 children; cooperative cleanup |
| `race-cleanup.ts` | `.return()` drain + timeout handling |
| `tool-actor-node.ts` | Execute proposed tool calls from blackboard/turn |
| `memory-node.ts` | Memory read/write node |
| `policy-gate-node.ts` | 3-state policy gate; emits `policy.evaluated` |
| `mode-policy-gate-node.test.ts` | Mode-policy gate coverage |
| `human-approval-node.ts` | Human approval wait node |
| `resume-gate-node.ts` | Resume gate + helpers |
| `critic-node.ts` | Draft→Critic→QualityGate; sets `critic.passed` |
| `supervisor-node.ts` | Retry-vs-escalate; backoff computed/emitted, never slept |
| `speculative-node.ts` | Concurrent branches; `rankBy` + `stopThreshold` early-stop |
| `verification-node.ts` | Verification step node |
| `draft-frontmatter-node.ts` | Draft frontmatter IO node |
| `intent-bridge-node.ts` | Intent bridging between stages |
| `dual-review-route-node.ts` | Dual-review routing |
| `dual-fix-gate-node.ts` | Dual-fix gate |
| `metis-reject-gate-node.ts` | Metis reject gate for planner path |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `llm-actor/` | LLM actor + AI-SDK/tool bridge (see `llm-actor/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Nodes expose `AsyncIterable<AbgSignal>` (or registry-wrapped equivalents) — always reach a terminal signal.
- Static parallel ≠ fan-out: no `fanOutKey` → declared `children`; with `fanOutKey` → template over blackboard array.
- Race: reject >4 children at authoring; cleanup timeout default 5000ms cap 30000ms; cleanup failure can fail Race after a valid winner.
- Supervisor backoff is data (`supervisor.backoff` / `supervisor.evaluated`) — never `sleep`.
- Speculative losers abandoned via `.return()` on early-stop.
- Policy gate is 3-state and must emit `policy.evaluated`.
- Critic sets `critic.passed`; dual-review/executer F-nodes use structured `outputEnum` verdicts.
- Keep scaffold leaves in `leaf-nodes.ts` separate from real coding-agent runners registered in `../coding-agent-registry.ts`.

### Testing Requirements

- Per-node `*.test.ts` beside implementations; race split across `race-node*.test.ts`
- Composite coverage also in `../static-parallel.test.ts`, `../parallel-fan-out.test.ts`, `../selector.test.ts`, `../join.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/behavior/nodes/<file>.test.ts`

### Common Patterns

- Use `composite-node-utils` / test support rather than duplicating child iterator drains.
- Structured llm writers must satisfy LEVER B bi-coverage (see parent `../AGENTS.md`).
- Approval and policy denials emit lifecycle events — never silent booleans alone.

## Dependencies

### Internal

- `../graph-coordinator*.ts` — run context, scheduling
- `../signals.ts`, `../abg-emit.ts` — signal emission
- `../../tools/` — tool registry for tool-actor
- `../../persistence/` — draft frontmatter stores
- `@mission-control/protocol` — node specs, signals

### External

- `ai` — only via `llm-actor/` subtree

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
