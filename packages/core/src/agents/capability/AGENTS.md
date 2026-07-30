<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# capability

## Purpose

Priority-based registry of agent plugin providers. `CapabilityRegistry.loadAll` sorts providers descending by priority, invokes each `loadAgents`, and deduplicates by agent name (highest priority wins). No file I/O here — scanning lives inside each provider.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | `CapabilityRegistry` class — register/enable/disable/`loadAll`/`list` |
| `types.ts` | `AgentPluginProvider`, `AgentPluginProviderLoadResult`, `LoadContext` |
| `capability-registry.test.ts` | Priority sort, name dedup, provider_error diagnostics, enable/disable |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Builtin 4-scope provider must stay at **priority 100**; cross-harness providers at **50** (`../providers/`).
- Rejecting provider → `provider_error` diagnostic; load continues.
- Duplicate name → `duplicate_name` warning; later (lower priority) entry dropped.
- `enableProvider` / `disableProvider` toggle without unregistering.
- Registry performs no I/O; keep it pure orchestration.

### Testing Requirements

- `capability-registry.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/agents/capability/capability-registry.test.ts`

### Common Patterns

- Provider interface: `{ id, displayName, priority, loadAgents(ctx) → { agents, diagnostics } }`.
- `LoadContext` carries workspace/config paths from `discoverAgents`.

## Dependencies

### Internal

- `../agent-loader.ts` — diagnostic types, discovery entry
- `../../util/error-to-string.ts` — provider error formatting
- `@mission-control/protocol` — `AgentDefinition`

### External

- None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
