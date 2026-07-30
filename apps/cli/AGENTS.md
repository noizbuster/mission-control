<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# cli

## Purpose

`apps/cli` owns the `mc` command-line application (`mctrl` alias retained): argument parsing, command orchestration, auth/model/session/MCP commands, the interactive chat loop, approval brokering, noninteractive renderers (plain/JSON/JSONL), and production tool-registry wiring. Interactive OpenTUI rendering lives in `apps/tui`; this package lazy-loads it only when `useTui === true`.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | `@mission-control/cli`; bins `mc`/`mctrl` → `./dist/index.js`; exports `./args`, `./commands/run-agent`, `./commands/session`, `./commands/mission-control-services` |
| `project.json` | Nx `cli:*` targets |
| `tsconfig.json` | Package TS config (strict workspace defaults) |
| `vite.config.ts` | Multi-entry Vite build (`index`, `args`, `commands/*`) |
| `DESIGN.md` | CLI product/UX design notes |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | CLI source: entry, args, commands, noninteractive UI (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Keep CLI behavior behind `apps/cli`; do not move command-line parsing or terminal orchestration into `packages/core`.
- Never statically import `@opentui/*`, `solid-js`, or TUI components. Reach TUI only via `@mission-control/tui` **lazy** imports inside the `useTui` branch so `mc --no-tui` stays opentui-free.
- Argument parsing stays parse-only (`args.ts`, `run-args.ts`, `auth-args.ts`, `session-args.ts`, `mcp-args.ts`). Runtime effects belong in `src/commands/`.
- `prebuild` runs `tui:build`; CLI dist depends on TUI dist subpaths.
- Product version: `src/cli-version.ts` — never static-import `index.tsx` from interactive paths (top-level `await runCli()` deadlocks).
- Auth via `auth-store.ts`; never print raw API keys/OAuth tokens.
- Help text, JSON, JSONL, and plain output are user-facing contracts.

### Testing Requirements
- Colocated `*.test.ts` under `src/`.
- Focused: `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:test` or `pnpm exec vitest run apps/cli/src/<file>.test.ts`.
- Interactive TUI runtime: tmux QA (start CLI, prompt, `/exit`, Ctrl+C). Full OpenTUI component tests live in `apps/tui`.
- Integration tests inject scripted `ChatInput`/`ChatOutput` and bypass OpenTUI.

### Common Patterns
- `import type` from `@mission-control/tui/state`; runtime mount via `await import('@mission-control/tui/create-chat-tui')`.
- Inject `ChatAppActions` + `MissionControlServices` into TUI; TUI never imports CLI.
- `exactOptionalPropertyTypes`: conditional spreads for optional props.
- User echo → `You: ` prefix; errors → `Error: ` prefix; slash commands are not echoed.
- Workspace root: `--workspace` > `MCTRL_WORKSPACE` > `detectWorkspaceRoot()`.
- `--profile <name>` long-only (auth `-p` is provider shorthand).

## Dependencies

### Internal
- `@mission-control/tui` — interactive mount/store/components (lazy)
- `@mission-control/core` — runtime, tools, sessions, providers, skills, workflows
- `@mission-control/protocol` — shared schemas/types
- `@mission-control/config` — product constants, model catalog

### External
- `vite` — multi-entry build
- `zod` — validation (dev)
- `ai` / `@ai-sdk/provider` — provider typing (dev)

<!-- MANUAL: -->
