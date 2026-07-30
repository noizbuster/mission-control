<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# anthropic

## Purpose

Anthropic Messages API provider adapter: request body construction (including thinking variants), HTTP/SSE transport, event mapping, tool-call handling, error normalization, and factory.

## Key Files

| File | Description |
|------|-------------|
| `anthropic-messages-provider.ts` | `createAnthropicMessagesProvider` |
| `anthropic-messages-request.ts` | Request body + variant mapper/gate + API key helper |
| `anthropic-messages-transport.ts`, `anthropic-messages-http-transport.ts` | Stream transport |
| `anthropic-messages-mapper.ts`, `anthropic-messages-events.ts`, `anthropic-messages-event-schemas.ts` | Chunk/event mapping and schemas |
| `anthropic-messages-state.ts` | Stream assembly state |
| `anthropic-messages-errors.ts` | Error normalization |
| `anthropic-messages-test-support.ts` | Shared test helpers |
| `*.test.ts`, `anthropic.live.test.ts` | Unit/contract/variant/tools + optional live |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Thinking variants: `thinking-*` → `thinking.budget_tokens` with paired `max_tokens` override; unconfigured variant → omit field (no throw).
- Never leak API keys in errors, events, or fixtures.
- Live test is opt-in only.
- Follow shared adapter layout (request/transport/mapper/errors/provider).

### Testing Requirements

- Provider/tools/variant/contract/errors tests in this dir; no live calls in default CI

### Common Patterns

- Factory returns `ProviderAdapter`; turn runner owns retries/timeouts
- Event schemas validate SSE payloads before mapping

## Dependencies

### Internal

- `../shared/` SSE + transport error helpers
- Parent credential resolver / redaction
- `@mission-control/config` variant catalog
- `@mission-control/protocol`

### External

- Anthropic Messages HTTP API

<!-- MANUAL: -->
