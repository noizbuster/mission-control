<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# budget

## Purpose

Graph-run cost accounting and node-run budget extension. `CostLedger` prices LLM usage against an operator-supplied `PricingTable` and emits `policy.budget.*` events. When `maxNodeRuns` is exhausted, an agent grantor (not a human) may APPROVE/DENY chunked extensions under a hard ceiling.

## Key Files

| File | Description |
|------|-------------|
| `cost-ledger.ts` | `CostLedger`, `PricingEntry`/`PricingTable`, `DEFAULT_PRICING=[]`, `extractTokenUsage`, `resolvePricing` |
| `cost-ledger.test.ts` | Pricing match, accumulation, warning/exceeded events |
| `node-run-budget-extension.ts` | Grant types, `DEFAULT_NODE_RUN_BUDGET_GRANT=40`, `DEFAULT_MAX_NODE_RUN_BUDGET_EXTENSIONS=2`, apply helpers |
| `node-run-budget-extension.test.ts` | Grant chunking + ceiling tests |
| `agent-node-run-budget-grantor.ts` | `createAgentNodeRunBudgetGrantor` — one-shot LLM APPROVE/DENY, fail-closed |
| `agent-node-run-budget-grantor.test.ts` | Grantor parse + deny-on-error |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- **Pricing is operator-supplied.** `DEFAULT_PRICING` is empty on purpose — never ship stale list prices.
- Wire tables via `AbgGraphRunnerInput.pricingTable`; missing model entry → cost 0 (ceiling still runs but won't self-trip).
- Most-specific pricing match: exact modelID → family-prefix → provider-only.
- Token fields extracted defensively from AI-SDK `usage` (`inputTokens`/`outputTokens`/`reasoningTokens`/`cachedInputTokens`).
- Events: `policy.budget.accumulated` every turn; `.warning` at `warnAtCents`; `.exceeded` at ceiling.
- Threaded as `AbgNodeRunContext.budgetLedger` from coordinator (`graph.defaults.model.budgetCents` + pricing table).
- Budget extension: chunked grants, `maxExtensions` hard stop; grantor fails closed (DENY) on model/transport errors.
- Reply format for grantor: exactly `APPROVE <n>` or `DENY <reason>`.

### Testing Requirements

- `cost-ledger.test.ts`, `node-run-budget-extension.test.ts`, `agent-node-run-budget-grantor.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/behavior/budget/<file>.test.ts`

### Common Patterns

- Coordinator builds ledger once per graph run; llm-actor records usage after each turn.
- Extension requester is injectable (`NodeRunBudgetExtensionRequester`) for tests without LLM.

## Dependencies

### Internal

- `@mission-control/protocol` — `AbgNodeModelOptions`
- `../nodes/llm-actor/llm-actor-node.ts` — `LlmActorModel` type for grantor
- `../graph-coordinator.ts` — wires ledger + extension into run context

### External

- `ai` — `generateText` in agent grantor (injectable)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
