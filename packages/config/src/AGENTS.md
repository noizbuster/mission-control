<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

Source for `@mission-control/config`: public barrel, Models.dev catalog transform/runtime, provider capability map, model-variant presets and user overrides, and pure model-context preference helpers used by CLI/TUI settings.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Public exports: product constants, `modelProviderCatalog` / `opencodeProviderCatalog`, `getRuntimeModelProviderCatalog`, `isExecutableCodingProvider`, re-exports |
| `index.test.ts` | Catalog constants, OpenCode vendored catalog, executable-provider contracts |
| `models-dev-runtime.ts` | Raw models.dev types, vendored snapshot load, TTL cache fetch, `getModelContextLimit` |
| `models-dev-runtime.test.ts` | Context-limit lookup and vendored-catalog contracts |
| `model-variant-presets.ts` | `variantsForReasoningOptions` — `reasoning-*` / `thinking-*` / budget-token tiers |
| `model-variant-overrides.ts` | `loadVariantOverrides` from `.mctrl/model-variants.json` and user config dir (first-wins merge) |
| `model-context-prefs.ts` | Slider steps, `resolveEffectiveContextLimit`, auto-compact threshold helpers |
| `model-context-prefs.test.ts` | Preference keying, override precedence, step helpers |
| `provider-capabilities.ts` | `generatedProviderCapabilities` map (`executable` + `adapterFamily` per provider id) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `generated/` | **Skip hand-edits** — vendored `models-dev-catalog.json`, `pricing-table.json` (large snapshots) |

## For AI Agents

### Working In This Directory
- Export new public symbols through `index.ts` only.
- When adding a provider to the executable set, update `provider-capabilities.ts` and ensure a matching core adapter family exists (`openai-responses`, `anthropic-messages`, `google-gemini`, `openai-compatible`, or local).
- `variantsForReasoningOptions`: Anthropic/Google use `thinking-*`; most others `reasoning-*`. Stale variants are dropped silently by core request mappers — keep preset ids aligned with those mappers.
- Override paths (project then user): `.mctrl/model-variants.json`, `$XDG_CONFIG_HOME/mission-control/model-variants.json` (or `~/.config/...`). Project keys win; do not invent extra search roots without updating tests.
- Context prefs are keyed `providerID/modelID` (variant-agnostic).

### Testing Requirements
- Prefer pure unit tests; avoid network. Runtime catalog refresh should be mocked or left unhit.
- `index.test.ts` locks default local selection (`local` / `local-echo`) and absence of `mock` in the shipped catalog.

### Common Patterns
- `import … from './generated/….json' with { type: 'json' }`
- Capability fallback: `generatedProviderCapabilities[id] ?? generatedDefaultProviderCapability`
- Login priority sort is applied when building the public catalog list

## Dependencies

### Internal
- `@mission-control/protocol` — `ProviderExecutionCapability`, preference/selection types, catalog schemas in tests
- Parent package build/test targets in `../project.json`

### External
- Node `fs` / `fs/promises` / `path` / `os` for override + cache I/O only

<!-- MANUAL: -->
