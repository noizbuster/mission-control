<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# openai-compatible

## Purpose

OpenAI-compatible gateway adapter covering multiple provider IDs (OpenRouter, Groq, Mistral, ZAI coding-plan, etc.): per-spec request shaping, variant/reasoning mapping differences, HTTP/SSE transport, event mapping, and unsupported-spec guards.

## Key Files

| File | Description |
|------|-------------|
| `openai-compatible-provider.ts` | `createOpenAICompatibleProvider` |
| `openai-compatible-request.ts` | Transport request + credential bearer helper |
| `openai-compatible-specs.ts` | `OPENAI_COMPATIBLE_PROVIDER_SPECS` / `openAICompatibleProviderSpec` |
| `openai-compatible-transport.ts`, `openai-compatible-http-transport.ts` | Stream transport |
| `openai-compatible-mapper.ts`, `openai-compatible-events.ts`, `openai-compatible-event-schemas.ts` | Mapping/schemas |
| `openai-compatible-errors.ts` | Error normalization |
| `openai-compatible-test-support.ts` | Test helpers |
| `*.test.ts`, `openai-compatible.live.test.ts` | Provider/variant/unsupported/contract + optional live |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Spec table drives base URL, auth header style, and reasoning field dialect:
  - openrouter: `reasoning.effort`
  - groq/mistral: `reasoning_effort`
  - zai-coding-plan (GLM 5.2+): `thinking:{type:"enabled"}` + `reasoning_effort` (`high`/`max` only)
- Unconfigured variant → omit reasoning fields (never throw).
- Reject/guard unsupported provider IDs via specs + `openai-compatible-unsupported.test.ts`.
- No live network in default CI; live file opt-in.

### Testing Requirements

- `openai-compatible-provider.test.ts`, `*-variant.test.ts`, `*-unsupported.test.ts`, `*-http-transport.test.ts`, contract tests

### Common Patterns

- One adapter, many specs — add a new gateway by extending specs + tests, not forking the adapter

## Dependencies

### Internal

- `../shared/`, parent credentials/redaction, config catalog, protocol

### External

- OpenAI-compatible HTTP APIs (OpenRouter, Groq, Mistral, ZAI, …)

<!-- MANUAL: -->
