<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# google

## Purpose

Google Gemini `generateContent` provider adapter: request construction (thinking budget variants), HTTP/SSE transport, event mapping, tools, errors, and factory.

## Key Files

| File | Description |
|------|-------------|
| `gemini-generate-content-provider.ts` | `createGeminiGenerateContentProvider` |
| `gemini-generate-content-request.ts` | Body + variant mapper + API key helper |
| `gemini-generate-content-transport.ts`, `gemini-generate-content-http-transport.ts` | Stream transport |
| `gemini-generate-content-mapper.ts`, `gemini-generate-content-events.ts`, `gemini-generate-content-event-schemas.ts` | Mapping/schemas |
| `gemini-generate-content-state.ts` | Stream state |
| `gemini-generate-content-errors.ts` | Error normalization |
| `gemini-generate-content-test-support.ts` | Test helpers |
| `*.test.ts`, `google.live.test.ts` | Unit/contract/variant/tools + optional live |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Thinking variants: `thinking-*` → `generationConfig.thinkingConfig.thinkingBudget`; unconfigured → omit (no throw).
- No credential leakage in errors/events/fixtures.
- Live test opt-in only.
- Match sibling adapter file layout for discoverability.

### Testing Requirements

- Provider/tools/variant/contract tests here; mocked transport in unit tests

### Common Patterns

- Same split as openai/anthropic adapters; shared SSE helpers from `../shared/`

## Dependencies

### Internal

- `../shared/`, parent credentials/redaction, config variant presets, protocol

### External

- Google Gemini generateContent API

<!-- MANUAL: -->
