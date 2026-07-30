<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# apps

## Purpose

User-facing application packages for Mission Control: the `mc`/`mctrl` CLI, the private OpenTUI interactive chat shell consumed by the CLI, and the React/Vite + Tauri desktop inspector. Apps orchestrate `@mission-control/core` and `@mission-control/protocol`; they must not own runtime internals.

## Key Files

No package lives at this directory root. Each child app has its own `package.json`, `project.json`, `tsconfig.json`, and `vite.config.ts`.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `cli/` | `mc`/`mctrl` CLI: args, commands, noninteractive renderers (see `cli/AGENTS.md`) |
| `tui/` | Private OpenTUI app: Solid components, keymap platform, chat mount/store seam (see `tui/AGENTS.md`) |
| `desktop/` | React/Vite UI + Tauri v2 shell for session inspection (see `desktop/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Prefer editing the specific app package, not inventing cross-app shared code here.
- CLI depends on TUI (`prebuild` runs `tui:build`). Desktop is React; TUI is Solid + OpenTUI — do not mix JSX runtimes.
- Product names: CLI `mc` (`mctrl` alias), desktop `mission-control`.
- UI surfaces consume protocol/core events and client abstractions only.

### Testing Requirements
- Per-app: `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run <cli|tui|desktop>:test`
- Desktop Tauri Rust: `pnpm exec nx run desktop:tauri-test` or `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- Root contract tests under `tests/` lock CLI/TUI boundaries and desktop README contracts.

### Common Patterns
- Workspace packages via `workspace:*`; Vite library builds emit `dist/`.
- CLI bin maps `mc` and `mctrl` → `./dist/index.js` with Node `--experimental-ffi` shebang for OpenTUI.
- Colocated `*.test.ts` / `*.test.tsx` inside each app.

## Dependencies

### Internal
- `@mission-control/core`, `@mission-control/protocol`, `@mission-control/config`
- CLI → `@mission-control/tui`
- Desktop → Tauri command bridge under `desktop/src-tauri`

### External
- CLI/TUI: Vite, Vitest, OpenTUI (`@opentui/*`), Solid (TUI only)
- Desktop: React 19, Vite, `@tauri-apps/api`, Zod

<!-- MANUAL: -->
