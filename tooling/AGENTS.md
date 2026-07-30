<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# tooling

## Purpose

Shared build-tooling modules used by package/app Vite configs. Not a pnpm workspace package and not shipped in release artifacts. Today holds the Mission Control library-mode Vite config factory so `packages/*` and `apps/*` share one external-predicate and optional CLI shebang banner.

## Key Files

No files at this directory root.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `vite/` | `createMissionControlLibConfig` and tests (see `vite/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Keep tooling free of runtime product logic — build/config helpers only.
- Consumers import relative paths like `../../tooling/vite/create-mission-control-lib-config.ts` from package vite configs.
- CLI entry shebang constant `MISSION_CONTROL_FFI_SHEBANG` (`#!/usr/bin/env -S node --experimental-ffi`) must stay byte-stable; packaging and FFI-loaded OpenTUI depend on it.
- No Solid/OpenTUI plugins here — TUI supplies its own Vite config.

### Testing Requirements
- `tooling/vite/create-mission-control-lib-config.test.ts` via root Vitest
- No Nx project target for `tooling/` currently

### Common Patterns
- Pure functions returning Vite `UserConfig` slices
- External predicate: `node:` builtins + configured package name prefixes
- Optional entry-only banner by output `fileName`

## Dependencies

### Internal
- Used by `packages/*/vite.config.ts` and app library builds (CLI, etc.)

### External
- `vite` types only at authoring time; tests via Vitest

<!-- MANUAL: -->
