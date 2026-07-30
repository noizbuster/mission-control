<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# replay

## Purpose

Deterministic LLM turn replay from recorded provider envelopes (ABG §7.5). Drives an LLMActor-equivalent signal sequence from a `RecordedTurn` without re-calling the model, so replayed timelines can be byte-identical to recorded ones (given deterministic emit sequencing).

## Key Files

| File | Description |
|------|-------------|
| `recorded-llm-replay.ts` | `replayRecordedTurn`, `RecordedTurn` / `RecordedToolCall` / `ReplayContext` types |
| `recorded-llm-replay.test.ts` | Signal sequence identity vs live vocabulary |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Recording contract = Phase-1 `LlmActorTurnResult.responseMessages` + emitted `llm.*`/`tool.*` events — nothing else.
- Sequence mirrors `runLlmActor`: started → `llm.turn.started` → text/tool deltas/proposals → `tool.completed` → `llm.turn.completed` → success.
- Use shared `createAbgEmitSignal` so ids/ordering match live runs when emit sequence is reset consistently.
- No model calls, no tool side effects — pure signal reconstruction.
- Do not expand the recording schema without updating live capture sites and tests together.

### Testing Requirements

- `recorded-llm-replay.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/behavior/replay/recorded-llm-replay.test.ts`

### Common Patterns

- `ReplayContext` supplies `graphId`, `nodeId`, `now()` for signal metadata.
- Pair with `resetEmitSequence` in `../abg-emit.ts` for byte-identical sequential runs.

## Dependencies

### Internal

- `../abg-emit.ts` — `createAbgEmitSignal`
- `@mission-control/protocol` — `AbgSignal`
- Conceptual pair: `../nodes/llm-actor/llm-actor-node.ts` live path

### External

- None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
