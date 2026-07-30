<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# llm-actor

## Purpose

LLMActor node (ABG §10.1): bridges Vercel AI SDK `streamText` into `AsyncIterable<AbgSignal>`. Structurally pins `stopWhen: stepCountIs(1)` so the ABG graph — not the SDK — owns the Observe→Decide→Act loop. Owns tool-bridge proposal execution, capability expand (advertising filter), structured-output tool, settlements, skill cache, and observability redaction hooks.

## Key Files

| File | Description |
|------|-------------|
| `llm-actor-node.ts` | `runLlmActor` — stream loop, retries, terminal signals |
| `llm-actor-node-runner.ts` | Registry runner wiring (prompt pack, tools, budget) |
| `llm-actor-node-types.ts` | `LlmActorModel`, `LlmActorRunInput`, `LlmActorTurnResult` |
| `llm-actor-node-helpers.ts` | Shared helpers for runner/node |
| `llm-actor-settlements.ts` | Tool settlement classification, approval-block, terminal failures |
| `llm-actor-skill-cache.ts` | Per-turn skill body cache |
| `ai-sdk-adapter.ts` | Stream part → ABG signals (`abgSignalsFromStreamPart`) |
| `abg-tool-bridge.ts` | Tool bridge between SDK tools and ABG proposals |
| `abg-tool-proposal-execution.ts` | Execute captured tool proposals |
| `capability-expand.ts` | Coarse→fine expand: node `capabilities` vs tool `capabilityClasses` (**advertising only**) |
| `structured-output-tool.ts` | Whole-output structured representation tool |
| `llm-actor-node-test-support.ts` | Test fixtures/doubles |
| `*.test.ts` | Runner, bridge, expand, settlements, cancellation, timeout, redaction |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- **Keystone:** every `streamText` call hardcodes `stopWhen: stepCountIs(1)`. No override. Multi-step SDK loops are forbidden here.
- Signals: `started` → `llm.turn.started` → deltas/proposals → either `llm.turn.completed`+success or `llm.error`+failure. Always terminal.
- Structured `outputKey`: whole exact representation only — no reasoning-tail parse, no last-line select, no invent-default on failure.
- Invalid structured admission → no blackboard write; emit retryable `invalid_structured_output` with correction payload.
- `capability-expand` is **advertising only**, not approval — see `docs/tool-permission-model.md`.
- Provider retries use shared `providers/provider-retry-policy` + chunk timeout helpers; indefinite-wait errors classified explicitly.
- Observability redaction via `ObservabilityRedactor` (default created if absent).
- Skill bodies pulled through skill cache on demand — not eager full inject.

### Testing Requirements

- `llm-actor-node.test.ts`, `llm-actor-node-runner.test.ts` (prompt guidelines/skills e2e)
- `abg-tool-bridge*.test.ts`, `ai-sdk-adapter.test.ts`, `capability-expand.test.ts`
- `llm-actor-settlements.test.ts`, cancellation/timeout/redaction/eval observability tests
- `structured-output-tool.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/behavior/nodes/llm-actor/<file>.test.ts`

### Common Patterns

- `createStreamPartObservabilityState` tracks partials for redaction-safe emits.
- Approval-blocked settlements preserve proposal order for deterministic failure selection.
- Runner assembles system prompt via `../../../context/system-prompt.ts` and filters tools via `capability-expand`.

## Dependencies

### Internal

- `../../../providers/` — flat bridge errors, retry policy, turn timeout, redactor
- `../../../context/` — system prompt assembly
- `../../../tools/` — tool registry registrations
- `../../abg-emit.ts`, `../../budget/` — emit sequence + cost ledger hooks
- `@mission-control/protocol` — `AbgSignal`

### External

- `ai` — `streamText`, `stepCountIs`, `ModelMessage`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
