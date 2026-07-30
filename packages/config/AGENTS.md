<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# config

## Purpose

`@mission-control/config` is the product-constants and model-catalog package. It owns CLI/product names, auth-file env keys, the scaffold + vendored Models.dev provider catalog, provider execution-capability tags, model-variant presets/overrides, and pure helpers for per-model context limits / auto-compact thresholds. No runtime I/O beyond optional catalog cache and variant-override file reads.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | `@mission-control/config`; depends on `@mission-control/protocol` only |
| `project.json` | Nx project `config`: build / typecheck / test |
| `tsconfig.json` | Package TS config |
| `vite.config.ts` | Library Vite build |
| `src/` | Source (see `src/AGENTS.md`) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Catalog, variants, context-pref helpers (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Keep product constants (`appName`, `cliCommandName`, `sidecarBinaryName`, auth env/schema URL) stable; root contract tests lock several of them.
- Catalog entries must validate against protocol `ProviderCatalogEntrySchema` / related shapes — do not invent ad-hoc provider records.
- `generated/` under `src/` is vendored snapshot data (models.dev catalog, pricing table). Prefer regenerating via scripts over hand-editing multi-MB JSON.
- Do not put runtime session/provider execution logic here; that belongs in `packages/core`.

### Testing Requirements
- Colocated Vitest: `src/*.test.ts`.
- Focused: `pnpm exec vitest run packages/config/src/<file>.test.ts`
- Package: `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run config:test`

### Common Patterns
- Static exports + pure functions; `getRuntimeModelProviderCatalog()` is the only async catalog path (cache + optional network refresh of models.dev).
- Variant selection syntax is documented at repo root (`provider/model#variant`); presets live in `model-variant-presets.ts`, file overrides in `model-variant-overrides.ts`.

## Dependencies

### Internal
- `@mission-control/protocol` — catalog/auth/capability/preference types and schemas
- Root `scripts/` — catalog sync helpers that refresh `src/generated/`

### External
- None at runtime beyond Node builtins (fs/path/os) for cache and override files

<!-- MANUAL: -->
