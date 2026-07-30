<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# openai

## Purpose

OpenAI Responses API adapter: request mapping (`store: false` default), reasoning variants, HTTP/SSE transport, tool-call mapping, error normalization, and provider factory. Mapping security notes in parent `../openai-responses-mapping.md`.

## Key Files

| File | Description |
|------|-------------|
| `openai-responses-provider.ts` | `createOpenAIResponsesProvider` |
| `openai-responses-request.ts` | Body, `openAIReasoningForVariant`, `isConfiguredOpenAIVariant`, bearer helper |
| `openai-responses-transport.ts`, `openai-responses-http-transport.ts` | Stream transport |
| `openai-responses-mapper.ts`, `openai-responses-events.ts` | Event/chunk mapping |
| `openai-responses-tool-calls.ts` | Tool-call extraction/mapping |
| `openai-responses-errors.ts` | Error normalization |
| `*.test.ts`, `openai.live.test.ts` | Unit/contract/variant/errors + optional live |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Default `store: false` unless user explicitly changes retention.
- Reasoning variants: `reasoning-*` → `reasoning.effort`; unconfigured → omit.
- Canonical variant-gate pattern other families mirror.
- Never put bearer tokens in logs/errors/events.
- Live smoke opt-in only.

### Testing Requirements

- `openai-responses-provider.test.ts`, `*-variant.test.ts`, `*-errors.test.ts`, `*-http-transport.test.ts`, contract tests
- Parent `../openai-responses-mapping.test.ts` for serialization rules

### Common Patterns

- Request/transport/mapper/tool-calls/errors/provider split
- Fixtures under `../fixtures/openai-responses.sse`

## Dependencies

### Internal

- `../shared/`, parent redaction/credentials, config variants, protocol
- Parent mapping doc `../openai-responses-mapping.md`

### External

- OpenAI Responses HTTP API

<!-- MANUAL: -->
