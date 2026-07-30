<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# ai-sdk

## Purpose

Bridge between flat `ProviderAdapter` (`streamTurn` chunks) and Vercel AI SDK `LanguageModelV3` used by the coding-agent graph (`streamText` / LLMActor). Includes async-credential model resolver and local-echo SDK model for offline graph tests.

## Key Files

| File | Description |
|------|-------------|
| `flat-provider-bridge.ts` | `wrapFlatProviderAsSdkModel` — flat adapter as `LanguageModelV3` |
| `flat-provider-bridge.test.ts` | Bridge chunk/message/tool translation + retry policy |
| `model-resolver.ts` | `createSdkModelResolver` — selection → SDK model (anthropic/openai/compatible/gemini) |
| `model-resolver.test.ts` | Resolver mapping and error cases |
| `local-echo-sdk-model.ts` | Deterministic local echo `LanguageModelV3` for tests |
| `local-echo-sdk-model.test.ts` | Echo model behavior |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Faithful transport adapter only — not full flat↔graph event parity. Run lifecycle stays with session run owner; redaction/replay vocabularies are separate concerns.
- `createSdkModelResolver` is an async factory (auth store) returning a **sync** per-node resolver after pre-resolving the run credential.
- Reuse flat runner retry/backoff when bridging `streamTurn`.
- Do not open live network in default tests; use local-echo or injected flat providers.
- Keep ABG signal vocabulary on the provider-events path — no dual vocabularies here.

### Testing Requirements

- `flat-provider-bridge.test.ts`, `model-resolver.test.ts`, `local-echo-sdk-model.test.ts`

### Common Patterns

- SDK messages/tools → `ProviderTurnRequest` → `streamTurn` → `LanguageModelV3StreamPart`
- Graph path consumes resolver; CLI non-interactive tests inject flat providers through the bridge

## Dependencies

### Internal

- Parent `ProviderAdapter` / turn types / retry policy
- Sibling provider factories (openai, anthropic, google, openai-compatible)
- `../../behavior/nodes/llm-actor/` consumer
- Credential/auth store modules in parent

### External

- Vercel AI SDK (`LanguageModelV3`, `streamText` consumer side)

<!-- MANUAL: -->
