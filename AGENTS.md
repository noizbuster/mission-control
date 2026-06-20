# Mission Control Agent Guide

**Generated:** 2026-06-20T00:30:00+09:00
**Commit:** 5b04ce5
**Branch:** master

## Overview

`mission-control` is a staged control surface for observable LLM-agent workflows. It implements a bounded coding-agent MVP over the original scaffold: provider turns, durable JSONL sessions, approval-gated tools, replay projections, graph coordination, CLI chat, desktop inspection, and a versioned sidecar handshake. It still does not implement the full ABG engine.

Product names:

- CLI command: `mctrl`
- Desktop app: `mission-control`
- Native helper binary: `mission-control-sidecar`

Design references:

- `ABG.md`: root design reference.
- `docs/ABG.md`: mirror of root `ABG.md`.
- `docs/ABG.ko.md`: Korean ABG document.
- `README.md`: scaffold architecture, distribution story, and extension points.

## Structure

```text
mission-control/
|-- apps/cli/                 # mctrl CLI
|-- apps/desktop/             # React/Vite UI plus Tauri shell
|-- packages/protocol/        # shared Zod schemas and exported protocol types
|-- packages/core/            # runtime, sessions, providers, tools, sidecar fallback, ABG scaffolding, MCP clients, skills
|-- packages/config/          # product constants and vendored model catalog snapshot
|-- native/sidecar/           # Rust JSON Lines sidecar binary
|-- scripts/                  # install, packaging, catalog sync helpers, smoke tests
|-- tests/                    # root workspace, README, workflow, integration, contract tests
|-- examples/abg/             # valid and intentionally invalid authorable graph fixtures
`-- .omo/plans/               # work plans and execution state (gitignored agent state)
```

Scoped guidance:

- `apps/cli/AGENTS.md`
- `apps/desktop/AGENTS.md`
- `packages/protocol/AGENTS.md`
- `packages/core/AGENTS.md`
- `packages/core/src/behavior/AGENTS.md`
- `packages/core/src/context/AGENTS.md`
- `packages/core/src/providers/AGENTS.md`
- `packages/core/src/runtime/AGENTS.md`
- `packages/core/src/tools/AGENTS.md`
- `packages/core/src/tools/mcp/AGENTS.md`

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| CLI entry/help/version | `apps/cli/src/index.tsx` | `apps/cli/package.json` maps `mctrl` to `./dist/index.js`. |
| CLI command flow | `apps/cli/src/commands/run-agent.ts` | Chat, JSON/JSONL, graph, provider, sidecar selection. |
| CLI output | `apps/cli/src/ui/renderers.ts` | Plain, Ink, JSON renderer contracts. |
| Interactive chat Ink bridge | `apps/cli/src/commands/ink-chat-bridge.tsx` | Ink React tree ↔ imperative chat loop bridge. |
| Desktop entry/UI | `apps/desktop/src/main.tsx`, `apps/desktop/src/App.tsx` | Browser-facing shell. |
| Desktop client boundary | `apps/desktop/src/lib/agent-client.ts` | Mock and Tauri clients, Zod response parsing. |
| Tauri native shell | `apps/desktop/src-tauri` | Command bridge and Rust session-log parsing. |
| Protocol exports | `packages/protocol/src/index.ts` | Public schema/type surface. |
| Core exports | `packages/core/src/index.ts` | Public runtime surface. |
| Runtime facade | `packages/core/src/agent-runtime.ts` | Session lifecycle, event emission, sidecar/provider/graph dispatch. |
| Sidecar client | `packages/core/src/native` | Process handshake, status, timeout, mock fallback. |
| Native sidecar entry | `native/sidecar/src/main.rs` | Rust JSONL process entry. |
| Packaging | `scripts/package-cli.ts`, `scripts/install.sh` | CLI tarball and install contract. |
| Workflow contracts | `.github/workflows/*.yml`, `tests/workflow-yaml.test.ts` | CI and release expectations. |
| MCP config schema | `packages/protocol/src/mcp-config.ts` | Local/remote MCP server config, LSP config placeholder, strict schemas. |
| Permission kinds | `packages/protocol/src/permission-profile.ts` | `read`/`edit`/`write`/`patch`/`bash`/`network`/`subagent` PermissionKind union. |
| Skills loader | `packages/core/src/skills/skill-loader.ts` | 3-scope first-wins SKILL.md discovery, denylist, symlink defense. |
| MCP clients | `packages/core/src/tools/mcp/` | Stdio + remote transports, config loader, connection manager, namespaced surfacing, secret redaction. |
| System prompt | `packages/core/src/context/system-prompt.ts` | Persona + env + tools + guidelines + `<available_skills>` XML assembly. |
| Interactive TUI | `apps/cli/src/commands/ink-chat-bridge.tsx` | Ink keyboard router, agent spinner, approval overlay, model picker. |

## Code Map

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `AgentRuntime` | class | `packages/core/src/agent-runtime.ts` | Main runtime facade. |
| `SessionRunCoordinator` | class | `packages/core/src/runtime/run-coordinator.ts` | Prompt admission and run control. |
| `ProviderTurnRunner` | class | `packages/core/src/providers/provider-turn-runner.ts` | Provider streaming, retries, tool loop bounds. |
| `ToolRegistry` | class | `packages/core/src/tools/tool-registry.ts` | Schema-bound tool registration and invocation. |
| `AgentEventSchema` | Zod schema | `packages/protocol/src/schema.ts` | Shared event contract. |
| `AbgGraphSpecSchema` | Zod schema | `packages/protocol/src/abg.ts` | Authorable graph contract. |
| `SIDECAR_PROTOCOL_VERSION` | const | `packages/protocol/src/sidecar.ts`, `native/sidecar/src/protocol.rs` | Sidecar wire version. |

## Conventions

- Package manager: `pnpm`; task runner/cache: Nx; compiler: `tsc`; tests: Vitest and Cargo; formatter/linter: Biome; desktop: React + Vite + Tauri v2; runtime validation: Zod.
- Root scripts intentionally prefix Nx with `NX_DAEMON=false NX_ISOLATE_PLUGINS=false`. Keep that unless local sandbox and CI are both verified without it.
- TypeScript stays strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `noPropertyAccessFromIndexSignature` are active.
- Use `import type` for type-only imports. Prefer named exports in app/library code.
- Values crossing package, CLI, desktop, provider, session-log, or sidecar boundaries belong in `packages/protocol` first.
- UI surfaces consume protocol/core events and client abstractions; they must not reach into runtime internals.
- Rust sidecar behavior stays behind the JSON Lines protocol boundary.
- Keep `Cargo.lock` files for Rust crates unless deliberately updating dependencies.
- Biome owns lint/format config. Do not add ESLint or Prettier for routine linting.
- Commit source, docs, tests, config, lockfiles, and workflows. Do not edit generated `dist`, `build`, `target`, `coverage`, `.nx`, `.omo`, `evidence`, `temp`, or reference-repo files.

## Anti-Patterns

- Do not remove mock/fallback behavior while the project remains a scaffold.
- Do not implement unrestricted tools, automatic rollback, persistent vector memory, or the full ABG engine unless explicitly requested.
- Do not make `native/sidecar` depend on TypeScript runtime internals.
- Do not serialize raw provider credentials into events, JSONL logs, CLI output, desktop state, errors, or evidence.
- Do not use `any`, `as any`, `as unknown`, `@ts-ignore`, `@ts-expect-error`, or non-null assertions.
- Do not use `unwrap`, `expect`, or `panic` in Rust production code; Cargo lints deny them.
- Do not change release artifact names without updating `scripts`, workflows, README, and contract tests.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm lint
pnpm dev:cli
pnpm dev:cli -- --no-tui
pnpm dev:cli -- --json
pnpm dev:desktop
pnpm dev:sidecar
pnpm dev:package-cli
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx show projects
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run desktop:test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run desktop:tauri-test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run sidecar:test
cargo test --manifest-path native/sidecar/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Notes

- Root contract tests under `tests/` lock README language, workflow content, workspace structure, Nx targets, ABG docs, package names, scripts, and protocol exports.
- Package/app tests are colocated as `*.test.ts` or `*.test.tsx`.
- Rust sidecar tests are inline in `native/sidecar`; Tauri Rust tests live under `apps/desktop/src-tauri`.
- `scripts/install.sh` still contains `OWNER_PLACEHOLDER/mission-control`; replace or override it before public release.
- CLI release artifacts are named `mctrl-<os>-<arch>.tar.gz` and contain `mctrl` plus `mission-control-sidecar`.
- Desktop signing/notarization are TODOs until platform credentials exist.
- If a generated artifact must become source, document why before changing `.gitignore`.
