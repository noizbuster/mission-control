<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# scripts

## Purpose

Repo-root automation: CLI tarball packaging, install script, models.dev catalog sync into `packages/config`, bundled-agent markdown codegen for core, coding-agent built-dist smokes, TUI keymap graph guards, and changed-TypeScript size checks. Invoked by root `package.json` scripts and Nx workspace targets — not a workspace package.

## Key Files

| File | Description |
|------|-------------|
| `package-cli.ts` | Builds `mctrl-<os>-<arch>.tar.gz` (staged workspace packages + sidecar binary) |
| `package-cli-dependencies.ts` | Stages external/workspace package closure for the tarball |
| `package-cli-files.ts` | Contained directory copy helpers for packaging |
| `package-cli-manifest.ts` | Package manifest assembly |
| `package-cli-semver.ts` | Semver helpers for package artifacts |
| `package-cli-test-fixture.ts` | Test fixtures for packaging tests |
| `package-cli.test.ts` | Packaging unit/contract tests |
| `install.sh` | Downloads latest GitHub release tarball into `~/.local/bin` |
| `install.test.ts` | Install script contract tests |
| `sync-models-dev-catalog.ts` | Fetches models.dev → `packages/config/src/generated/{models-dev-catalog,pricing-table}.json` |
| `models-dev-catalog-builder.ts` | Snapshot/pricing builders for the catalog sync |
| `models-dev-auth-fields.ts` | Auth field derivation for catalog providers |
| `models-dev-catalog-builder.test.ts` | Catalog builder tests |
| `sync-models-dev-catalog.test.ts` | Sync entry tests |
| `generate-bundled-agents.mjs` | `bundled-src/*.md` → `packages/core/src/agents/bundled/*.md.ts` + index |
| `coding-agent-built-dist-smoke.ts` | End-to-end smoke against built CLI dist |
| `coding-agent-built-dist-mcp-smoke.ts` | Built-dist MCP tools smoke |
| `coding-agent-built-dist-smoke-support.ts` | Temp roots, buffered IO, git workspace helpers |
| `coding-agent-smoke-*.ts` | Shared smoke provider/approval/MCP fakes |
| `changed-typescript-size.ts` | PR size guard for changed TS (`pnpm check:changed-ts-size`) |
| `verify-no-tui-keymap-graph.mjs` | Forbids illicit TUI keymap graph coupling |
| `tui-keymap-qa.sh` | Keymap QA harness |
| `tui-keymap-trace-hooks.mjs` | Keymap trace hook injection |
| `tui-keymap-trace-register.mjs` | Keymap trace registration |
| `tsconfig.json` | TS config for scripts run via `node --experimental-strip-types` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `fixtures/` | Tiny script fixtures (e.g. `hanging-sidecar.sh`); not a docs subtree |

## For AI Agents

### Working In This Directory
- Prefer `node --experimental-strip-types scripts/<name>.ts` (matches root scripts).
- Release artifact name is `mctrl-<os>-<arch>.tar.gz` containing `mc`, `mctrl` alias, and `mission-control-sidecar`. Renames require scripts + workflows + README + contract tests together.
- `install.sh` still has a configurable `MISSION_CONTROL_REPO` (default `noizbuster/mission-control`).
- Catalog sync writes generated JSON under `packages/config/src/generated/` — do not hand-edit those outputs; re-run sync.
- Bundled-agent codegen is deterministic (alpha by filename); core `prebuild` depends on it.
- Do not commit packaging `dist` staging dirs or smoke temp roots.

### Testing Requirements
- Colocated `*.test.ts` run through root Vitest (`pnpm test` / vitest include globs).
- Smokes: `pnpm smoke:coding-agent-built-dist`, `pnpm smoke:coding-agent-mcp-tools` (require prior build).
- Packaging: `package-cli.test.ts`, `install.test.ts`.
- Skip running full smokes unless packaging/CLI dist behavior changed.

### Common Patterns
- ESM + `.ts` imports with explicit extensions where strip-types requires them.
- Platform detection normalizes to `linux|darwin` × `x64|arm64`.
- Sidecar resolution prefers `native/sidecar/target/release` then `debug`.

## Dependencies

### Internal
- Packages staged: `protocol`, `config`, `core`, `apps/tui` (+ CLI dist at package time)
- Sidecar binary from `native/sidecar`
- Catalog outputs → `packages/config/src/generated/`
- Bundled agents → `packages/core/src/agents/bundled/`
- Smoke imports `@mission-control/cli/*` and `@mission-control/core`

### External
- Node 26+, `curl`/`tar` for install.sh, Cargo-built sidecar for packaging
- `semver`, system `cargo` when resolving binaries

<!-- MANUAL: -->
