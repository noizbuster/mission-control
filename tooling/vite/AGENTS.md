<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# vite

## Purpose

Shared Vite library-mode helper for mission-control packages/apps. Builds ES lib bundles with a consistent external-dependency predicate, optional CLI entry shebang (`node --experimental-ffi`), and no Solid/opentui plugins.

## Key Files

| File | Description |
|------|-------------|
| `create-mission-control-lib-config.ts` | `createMissionControlLibConfig`, `createExternalDependencyPredicate`, `createEntryShebangBanner`, `MISSION_CONTROL_FFI_SHEBANG` |
| `create-mission-control-lib-config.test.ts` | Vitest coverage for externals, shebang banner bytes, and rollup wiring |

## Subdirectories

None.

## For AI Agents

### Working In This Directory
- Consumers: e.g. `apps/cli/vite.config.ts`, `packages/core/vite.config.ts`, `packages/protocol/vite.config.ts` — update call sites if the options type changes.
- Shebang must remain exact: `#!/usr/bin/env -S node --experimental-ffi\n` (trailing newline required for CLI bin entries).
- Externals: always treat `node:` builtins as external; package names match exact or `name/` subpath prefix; relative/absolute paths stay bundled.
- Defaults: `outDir: 'dist'`, `formats: ['es']`, `emptyOutDir: true`, `sourcemap: true`, entry/chunk fileName patterns fixed in helper.
- Do not add framework plugins here; app-specific Vite config stays in each package.

### Testing Requirements
- `vitest` on `create-mission-control-lib-config.test.ts` (via workspace test target that includes this path, or direct vitest run).
- After shebang changes, re-verify packaged CLI bin headers (`scripts/package-cli*.ts` contracts).

### Common Patterns
```ts
createMissionControlLibConfig({
  entry: { index: 'src/index.ts' },
  externalPackages: ['@mission-control/core', 'zod'],
  bannerEntryFileNames: ['index.js'], // optional FFI shebang
});
```

## Dependencies

### Internal
- Package/app `vite.config.ts` call sites under `apps/*`, `packages/*`
- Packaging scripts that assert CLI shebang bytes

### External
- `vite` (`UserConfig` type)
- `vitest` (tests)

<!-- MANUAL: -->
