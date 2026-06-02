# Mission Control Agent Guide

This file is the working knowledge base for future agents in this repository. Read it before changing code, docs, tests, workflows, or packaging.

## Project Summary

`mission-control` is a boilerplate control surface for observable LLM-agent workflows. It is intentionally a scaffold: it reflects ABG concepts through package boundaries, protocol schemas, event logs, sidecar boundaries, CLI/desktop surfaces, and extension points, but it does not implement the full ABG engine.

Primary product names:

- CLI command: `mctrl`
- Desktop app: `mission-control`
- Native helper binary: `mission-control-sidecar`

Design references:

- `ABG.md` is the root design reference.
- `docs/ABG.md` currently has the same content as root `ABG.md`.
- `docs/ABG.ko.md` is the Korean ABG document.
- `README.md` describes the current scaffold architecture, distribution story, and future extension points.

## Workspace And Tooling

This is a pnpm monorepo using Nx as the task runner.

Core tools:

- Package manager: `pnpm`
- Task runner/cache: `nx`
- TypeScript compiler: `tsc`
- Test runner: `vitest`
- Linter/formatter: `biome`
- Frontend: React + Vite
- Desktop shell: Tauri v2
- Native sidecar: Rust
- Runtime schema validation: Zod in `packages/protocol`

Do not add ESLint or Prettier config for routine linting. This repo uses Biome. `eslint.config.js` was intentionally removed because it was an empty unused stub.

Nx is configured in `nx.json` and per-project `project.json` files. Root package scripts set:

```bash
NX_DAEMON=false NX_ISOLATE_PLUGINS=false
```

Keep that environment prefix in root Nx scripts unless you have verified that the local sandbox and CI both work without it. In this environment, Nx daemon/plugin socket creation can fail without it.

## Project Structure

Top-level boundaries:

- `apps/cli`: TypeScript CLI application for `mctrl`.
- `apps/desktop`: React + Vite + Tauri desktop application.
- `packages/protocol`: Shared Zod schemas and TypeScript types for events, sessions, permissions, messages, and sidecar protocol.
- `packages/core`: Runtime skeleton, event bus, sessions, permissions, native sidecar client, mock sidecar behavior, scheduler/memory/action-graph placeholders.
- `packages/config`: Shared constants.
- `native/sidecar`: Rust JSON Lines sidecar binary.
- `scripts`: Install and packaging helpers plus tests.
- `tests`: Root workspace, README, workflow, integration, and contract tests.
- `boilerplating`: Ordered prompt-pack documents used to create the scaffold.
- `plans`: Work plans and execution state documents.

Important entry points:

- CLI entry: `apps/cli/src/index.tsx`
- CLI command flow: `apps/cli/src/commands/run-agent.ts`
- CLI renderers: `apps/cli/src/ui/renderers.ts`
- Desktop entry: `apps/desktop/src/main.tsx`
- Desktop UI: `apps/desktop/src/App.tsx`
- Desktop agent client boundary: `apps/desktop/src/lib/agent-client.ts`
- Tauri Rust crate: `apps/desktop/src-tauri`
- Protocol exports: `packages/protocol/src/index.ts`
- Core exports: `packages/core/src/index.ts`
- Runtime: `packages/core/src/agent-runtime.ts`
- Sidecar client boundary: `packages/core/src/native`
- Rust sidecar entry: `native/sidecar/src/main.rs`

Ignored/generated directories include `node_modules`, `.nx`, `.omo`, `evidence`, `dist`, `build`, `target`, and coverage outputs. Do not edit generated `dist` or Rust `target` files.

## Commands

Install dependencies:

```bash
pnpm install
```

Primary verification:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

Development entry points:

```bash
pnpm dev:cli
pnpm dev:cli -- --no-tui
pnpm dev:cli -- --json
pnpm dev:desktop
pnpm dev:sidecar
pnpm dev:package-cli
```

Useful focused Nx targets:

```bash
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx show projects
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run desktop:test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run desktop:tauri-test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run sidecar:test
```

Direct Rust checks:

```bash
cargo test --manifest-path native/sidecar/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

CI currently runs install, typecheck, build, and sidecar build in `.github/workflows/ci.yml`.

## Coding Conventions

TypeScript:

- Keep TypeScript strict. The base config uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `noPropertyAccessFromIndexSignature`.
- Avoid `any`, `as any`, `as unknown`, `@ts-ignore`, `@ts-expect-error`, and non-null assertions.
- Use `import type` for type-only imports.
- Use Zod at protocol/input boundaries.
- Preserve event-driven boundaries: UI should consume protocol/core events instead of reaching into runtime internals.
- Prefer named exports in application/library code. Default exports are acceptable for tool/framework config files that expect them.

Rust:

- Keep sidecar behavior behind the JSON Lines protocol boundary.
- Do not make Rust code depend on TypeScript runtime internals.
- Keep `Cargo.lock` files for the Rust applications/crates unless there is a deliberate dependency update.
- Avoid `unwrap`, `expect`, and `panic` in production code. Existing Cargo lints deny these patterns.

Frontend:

- Desktop UI lives in `apps/desktop/src`.
- Tauri command/native code lives in `apps/desktop/src-tauri`.
- Keep browser-facing code separated from native sidecar and runtime orchestration.

Formatting/linting:

- Use `pnpm lint` or `pnpm exec biome check --write .`.
- Biome may report warning/info diagnostics that do not fail the command; exit code is authoritative.

## Architecture Boundaries

Respect these ownership rules:

- `packages/protocol` owns shared schemas/types. If a value crosses package, CLI, desktop, or sidecar boundaries, define or update the schema here first.
- `packages/core` owns runtime behavior, event logs, permission skeletons, sidecar fallback, timeout behavior, and future ABG runtime placeholders.
- `apps/cli` owns command-line parsing, command orchestration, and renderers.
- `apps/desktop` owns desktop presentation and Tauri-facing client boundaries.
- `native/sidecar` owns native JSON Lines execution behavior.
- `packages/config` owns shared constants only.

Do not implement real LLM providers, real file-editing tools, persistent memory/vector stores, full scheduler/executor orchestration, or the full ABG behavior/action graph engine unless the task explicitly asks for that scope.

## Testing Guidance

Test surfaces:

- Package/app unit tests live next to source as `*.test.ts` or `*.test.tsx`.
- Root contract/integration tests live in `tests`.
- Rust sidecar tests live under `native/sidecar`.
- Tauri Rust tests live under `apps/desktop/src-tauri`.

When changing behavior:

- Add or update a failing test first when practical.
- For protocol changes, test schema parsing and exports.
- For runtime/sidecar changes, test native fallback, timeout, and emitted event behavior.
- For CLI changes, test plain output, JSON output, help/version, and argument parsing.
- For desktop UI changes, test rendered markup and event log fields.
- For workflow/package changes, update root contract tests in `tests`.

## Distribution And Release Notes

CLI distribution:

- `apps/cli/package.json` maps `mctrl` to `./dist/index.js`.
- `scripts/package-cli.ts` creates current-platform CLI archives in `dist/release`.
- Release artifact names follow `mctrl-<os>-<arch>.tar.gz`.

Desktop distribution:

- Desktop release workflow lives in `.github/workflows/release-desktop.yml`.
- Signing/notarization are TODOs until platform credentials exist.

Install script:

- `scripts/install.sh` is tested by `scripts/install.test.ts`.
- Repository owner placeholders must be replaced before public release.

## Git And Generated Files

Commit source, docs, tests, config, lockfiles, and workflow files.

Do not commit:

- `node_modules/`
- `.nx/`
- `.omo/`
- `evidence/`
- `dist/`
- `build/`
- `target/`
- coverage outputs
- local `.env*` files
- logs and temporary files

The `.gitignore` is intentionally broad for generated artifacts. If a generated artifact must become source, document why before changing `.gitignore`.

## Agent Workflow Notes

Before editing, identify the owning boundary and update the smallest relevant surface.

After edits, run the narrowest meaningful command first, then broaden as risk increases:

```bash
pnpm exec vitest run <specific-test-file>
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

For Rust or Tauri changes, include the relevant `cargo test --manifest-path ...` command.

If Nx appears to hang or fail while computing the graph, retry with:

```bash
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx show projects
```

Do not remove the mock/fallback behavior while the project remains a scaffold. It is part of the current contract.
