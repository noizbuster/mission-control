<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# packages

## Purpose

Shared TypeScript libraries for Mission Control. Boundary order is protocol → config → core. Values that cross package, CLI, desktop, provider, session-log, or sidecar boundaries belong in `protocol` first. `config` holds product constants and the vendored models.dev catalog. `core` is the runtime, sessions, providers, tools, workflows, agents, and ABG scaffolding.

## Key Files

No package root files here. Each child owns `package.json`, `project.json`, `tsconfig.json`, and `vite.config.ts`.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `protocol/` | Shared Zod schemas and exported protocol types (see `protocol/AGENTS.md`) |
| `config/` | Product constants, model catalog snapshot, variant presets (see `config/AGENTS.md`) |
| `core/` | Agent runtime, tools, providers, persistence, workflows, agents (see `core/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Dependency direction: `protocol` (Zod only) ← `config` (protocol) ← `core` (config + protocol). Apps depend on all three; packages never depend on apps.
- Prefer named exports; `import type` for type-only imports.
- Build via Vite library mode + `tsc --emitDeclarationOnly`. Shared helper: `tooling/vite/create-mission-control-lib-config.ts`.
- Core `prebuild` runs `scripts/generate-bundled-agents.mjs`.

### Testing Requirements
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run <protocol|config|core>:test`
- Root `tests/protocol-export.test.ts` locks the public protocol surface.
- Colocated `*.test.ts` next to sources under each package `src/`.

### Common Patterns
- Package names: `@mission-control/{protocol,config,core}`.
- Exports map `"."` → `dist/index.js` + types; core also exports `./replay` and `./redaction`.
- Strict TS: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- No `any` / `as any` / non-null assertions.

## Dependencies

### Internal
- `config` → `protocol`
- `core` → `config`, `protocol`
- Catalog codegen writes into `config/src/generated/` via `scripts/sync-models-dev-catalog.ts`

### External
- `protocol`: Zod
- `core`: AI SDK providers, `@libsql/client`, drizzle-orm, MCP SDK, diff, yaml, puppeteer-core, Zod
- Build: Vite, Vitest, TypeScript

<!-- MANUAL: -->
