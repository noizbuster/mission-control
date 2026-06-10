# Providers Agent Guide

## Overview

`packages/core/src/providers` owns provider-facing runtime behavior: deterministic local provider, credential resolution/redaction, provider turn envelopes, retry/timeout handling, tool-call loops, and the OpenAI Responses adapter.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Provider turn orchestration | `provider-turn-runner.ts` | Retries, timeout, abort, durable/ephemeral envelopes, tool loop bounds. |
| Provider contracts | `provider-turn-types.ts`, `provider-turn-events.ts` | Adapter interface and event helpers. |
| Deterministic provider | `deterministic-provider.ts` | Offline tests and demos. |
| Credential handling | `credential-resolver.ts` | Resolution, summaries, redaction classes. |
| OpenAI adapter | `openai/` | Request mapping, transport, error normalization, event mapping. |
| Mapping notes | `openai-responses-mapping.md` | Security and serialization rules for OpenAI Responses. |

## Conventions

- Never serialize raw credentials into protocol events, JSONL logs, CLI output, desktop props/state, errors, or evidence.
- Keep provider output redaction close to provider boundaries and test both raw-token and known-credential cases.
- Unsupported catalog providers remain auth/catalog metadata only until an adapter is implemented.
- OpenAI Responses requests default to `store: false`; preserve that unless the user explicitly changes retention behavior.
- Live OpenAI smoke tests are opt-in only and must not be required for CI.
- Provider turn events must preserve causation/correlation IDs and distinguish durable from ephemeral envelopes.

## Tests

- Turn runner: `provider-turn-runner.test.ts`, `provider-redaction.test.ts`.
- Credentials: `credential-resolver.test.ts`.
- OpenAI mapping and transport: `openai-responses-mapping.test.ts`, `openai/openai-responses-*.test.ts`.
- Live tests: `openai/openai.live.test.ts` must remain optional.

## Anti-Patterns

- Do not add a provider adapter by only adding it to the catalog.
- Do not leak token-like strings through thrown errors or model-visible text.
- Do not run live provider calls in default tests.
- Do not weaken timeouts, retry caps, or tool-call loop bounds without adding coverage for the new behavior.
