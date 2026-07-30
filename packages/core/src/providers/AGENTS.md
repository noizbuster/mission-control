<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# providers

## Purpose

Provider-facing runtime: deterministic/local providers, credential resolution and redaction, provider-turn envelopes (retry/timeout/abort/tool loops), factory wiring, observability, and first-party adapters (OpenAI Responses, Anthropic Messages, Google Gemini, OpenAI-compatible families) plus the AI-SDK bridge used by the coding-agent graph.

## Key Files

| File | Description |
|------|-------------|
| `provider-turn-runner.ts`, `provider-turn-types.ts`, `provider-turn-events.ts` | Turn orchestration, adapter contract, durable/ephemeral envelopes |
| `provider-turn-timeout.ts`, `provider-retry-policy.ts` | Timeout and retry/backoff policy |
| `provider-factory.ts`, `provider-adapter-contract-*.ts` | Adapter construction and shared contract tests |
| `credential-resolver.ts`, `provider-auth-store.ts`, `provider-auth-resolver.ts` | Credential resolution, auth store, summaries |
| `oauth-credential-refresh.ts` | OAuth refresh path |
| `redaction-handler.ts`, `observability-*-redactor.ts`, `observability-value-traversal.ts` | Boundary redaction for logs/events/chunks |
| `deterministic-provider.ts`, `local-coding-provider.ts`, `local-output-contract.ts` | Offline/test providers and local output contract |
| `stream-decoder.ts` | Shared stream line/frame decoding |
| `provider-stream-observability.ts`, `model-message-observability.ts`, `graph-run-result-observability.ts` | Observability helpers |
| `openai-responses-mapping.md` | Security/serialization notes for OpenAI Responses |
| `fixtures/*.sse` | Recorded SSE fixtures for adapter tests |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `ai-sdk/` | Flat `ProviderAdapter` ↔ AI SDK `LanguageModelV3` bridge + model resolver (see `ai-sdk/AGENTS.md`) |
| `anthropic/` | Anthropic Messages adapter (see `anthropic/AGENTS.md`) |
| `google/` | Gemini generateContent adapter (see `google/AGENTS.md`) |
| `openai/` | OpenAI Responses adapter (see `openai/AGENTS.md`) |
| `openai-compatible/` | OpenRouter/Groq/Mistral/ZAI-compatible adapter (see `openai-compatible/AGENTS.md`) |
| `shared/` | SSE transport, variant cache, transport error mapping (see `shared/AGENTS.md`) |
| `fixtures/` | Static SSE fixtures (skip empty narrative; test-only assets) |

## For AI Agents

### Working In This Directory

- Never serialize raw credentials into protocol events, JSONL logs, CLI output, desktop props/state, errors, or evidence.
- Keep redaction at provider boundaries; test raw-token and known-credential cases.
- Unsupported catalog providers remain auth/catalog metadata until an adapter exists — do not treat catalog entry as implementation.
- OpenAI Responses defaults `store: false`; preserve unless user explicitly changes retention.
- Live `*.live.test.ts` are opt-in only; never required for CI.
- Provider turn events preserve causation/correlation IDs and durable vs ephemeral envelopes.
- Each family owns `<provider>...ForVariant(modelID, variantID)` next to `createRequestBody`, gated by `isConfigured<Provider>Variant`. Unknown variant → silently omit reasoning/thinking field (never throw).
  - OpenAI Responses: `reasoning-*` → `reasoning.effort`
  - Anthropic Messages: `thinking-*` → `thinking.budget_tokens` + paired `max_tokens`
  - Google Gemini: `thinking-*` → `generationConfig.thinkingConfig.thinkingBudget`
  - OpenAI-compatible: `reasoning-*` → `reasoning.effort` (openrouter), `reasoning_effort` (groq/mistral), or `thinking:{type:"enabled"}` + `reasoning_effort` (zai-coding-plan GLM 5.2+, only `high`/`max`)
- Variant presets/matchers live in `packages/config/src/model-variant-presets.ts`.

### Testing Requirements

- Turn runner / redaction: `provider-turn-runner.test.ts`, `provider-redaction.test.ts`, `redaction-handler.test.ts`
- Credentials: `credential-resolver.test.ts`, `provider-auth-store.test.ts`, `oauth-credential-refresh.test.ts`
- Per-adapter: `<family>/*-provider.test.ts`, `*-variant.test.ts`, `*-contract.test.ts`, tools/errors as present
- Recorded fixtures: `provider-recorded-fixtures.test.ts` + `fixtures/`
- Live tests remain optional

### Common Patterns

- Adapter split: `*-request.ts` (body), `*-transport.ts` / `*-http-transport.ts`, `*-mapper.ts` / `*-events.ts`, `*-errors.ts`, `*-provider.ts` factory
- Shared SSE framing via `shared/sse-stream-transport.ts`
- Contract registrations keep families honest without live network

## Dependencies

### Internal

- `@mission-control/protocol` — provider/event schemas
- `@mission-control/config` — model catalog, variant presets
- `../behavior/nodes/llm-actor/` — graph consumes AI-SDK models
- `shared/`, `ai-sdk/`, per-provider dirs below

### External

- Vercel AI SDK (`ai` / provider packages) via `ai-sdk/`
- Provider HTTP APIs (OpenAI, Anthropic, Google, compatible gateways)
- Zod where local schemas apply

<!-- MANUAL: -->
