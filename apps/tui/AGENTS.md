<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# tui

## Purpose

`apps/tui` is the private Solid/OpenTUI app consumed by `apps/cli` via lazy import. It owns the Solid JSX tree (`@opentui/solid`), keymap platform, terminal viewport, markdown/diff pipelines, clipboard, typed transcript rendering, display-only projections, and the `ChatStore` state cluster. It MUST NOT import from `apps/cli` / `@mission-control/cli`, and MUST NOT own CLI parsing, auth, sessions, providers, or runtime orchestration.

Dependency direction is strictly CLI → TUI. Noninteractive `mc --no-tui`/`--json`/`--jsonl` never loads this package. CLI side effects reach components through injected `ChatAppActions`.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | `@mission-control/tui`; subpath exports for state, create-chat-tui, providers, keymap, markdown, app, etc. |
| `project.json` | Nx `tui:*` targets |
| `tsconfig.json` | `jsx: preserve`, `jsxImportSource: @opentui/solid` |
| `vite.config.ts` | Library-mode Vite; `vite-plugin-solid` universal generate against `@opentui/solid`; object entries mirror package exports |
| `DESIGN.md` | TUI design reference |
| `test-support/core-test-shim.ts` | Test shim for core imports in Vitest |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | TUI source root (see `src/AGENTS.md`) |
| `test-support/` | Package-level test shims (see `test-support/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Never import `apps/cli`, `../cli`, `../../cli`, or `@mission-control/cli` (enforced by `tests/tui-cli-boundary.test.ts`).
- Pure surface (`terminal-text`, `chat`, `markdown`) and `src/state/` stay free of `@opentui/*` and `solid-js` runtime imports.
- Main barrel `src/index.ts` = pure primitives + state only. Components/platform/mounts use dedicated subpath exports.
- Providers only via `@mission-control/tui/providers` — not the main barrel.
- OpenTUI Zig core loads via `node:ffi` (Node 26.3+); run CLI with `--experimental-ffi`.
- Interactive layout: `useTerminalDimensions()` only — no `process.stdout.columns/rows` in components/keymaps (`platform/terminal-global-policy.test.ts`).
- Solid components run once: never freeze reactive dimension reads into consts/destructured props.
- Pass scroll-owning components as inline JSX props — never IIFE wrappers (remount/scrollbar flash).

### Testing Requirements
- Colocated `*.test.ts`/`*.test.tsx` under `src/`.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run tui:test` or `pnpm exec vitest run apps/tui/src/<file>.test.ts`.
- Prefer Solid headless / pure-helper tests; state tests stay framework-free.
- Topology pins: `src/app/app-topology.test.ts`. Import graph: `src/import-graph.test.ts`.

### Common Patterns
- `createChatTui` → `ChatStore` + dynamic renderer/providers/App → `ChatTuiHandle`.
- Store selectors: `useSolidStoreSelector(store, selector)` — do not hand-roll subscribe bridges.
- `exactOptionalPropertyTypes`: conditional spreads; for always-mounted components prefer `prop: T | undefined`.
- Display sanitization only on terminal-bound text; raw graph keys/answers stay unsanitized in storage.
- Copy = mouse-up OSC52 only; Ctrl+C = interrupt/exit global sink.

## Dependencies

### Internal
- `@mission-control/core` — tui-stores, structural services (not AgentRuntime construction in components)
- `@mission-control/protocol` — shared types
- `@mission-control/config` — product constants

### External
- `@opentui/core`, `@opentui/solid`, `@opentui/keymap` — terminal UI
- `solid-js` — reactivity
- `marked`, `remend` — markdown
- `web-tree-sitter` — code highlighting
- `diff`, `wrap-ansi`, `@dagrejs/dagre` — diff/layout/graph
- `vite`, `vite-plugin-solid` — build

<!-- MANUAL: -->
