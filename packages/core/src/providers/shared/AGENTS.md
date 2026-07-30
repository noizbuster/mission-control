<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# shared

## Purpose

Cross-adapter provider utilities: SSE frame parsing/transport helpers, variant lookup cache, transport error mapping, and small request helpers used by openai/anthropic/google/openai-compatible families.

## Key Files

| File | Description |
|------|-------------|
| `sse-stream-transport.ts` | `parseSseFrames`, SSE request/stream options |
| `provider-transport-error.ts` | `mapProviderTransportError` normalized transport failures |
| `variant-cache.ts` | `createVariantLookup` / `SHARED_VARIANT_LOOKUP` |
| `variant-cache.test.ts` | Cache behavior |
| `provider-helpers.ts` | Credential resolve helper, tool-call message fields, JSON tool input parse |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Keep helpers provider-agnostic; family-specific mapping stays in sibling dirs.
- Transport errors must distinguish caller abort vs peer disconnect when signal available.
- Variant cache is shared read-through — do not bake provider-specific variant semantics here (those live next to each `createRequestBody`).

### Testing Requirements

- `variant-cache.test.ts`; other helpers covered via adapter tests

### Common Patterns

- Adapters import SSE + error mappers instead of reimplementing framing

## Dependencies

### Internal

- Parent provider types / credentials as referenced by helpers
- `@mission-control/protocol` where error/event shapes apply

### External

- Fetch/HTTP streaming primitives

<!-- MANUAL: -->
