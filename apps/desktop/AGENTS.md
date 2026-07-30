<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# desktop

## Purpose

`apps/desktop` owns the React/Vite desktop UI and the Tauri v2 native shell. Browser-facing code stays in `src/`; native command handlers and session-log reading stay in `src-tauri/`. UI talks only through `DesktopAgentClient` (mock + Tauri), never into `packages/core` runtime internals or workspace files directly.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | `@mission-control/desktop`; React 19 + Vite 8 + Tauri API + workspace protocol/core/config |
| `project.json` | Nx `desktop:*` targets (`test`, `tauri-test`, build/dev) |
| `tsconfig.json` | Package TS config |
| `vite.config.ts` | Vite dev/build for the webview UI |
| `index.html` | Webview HTML shell |
| `DESIGN.md` | Desktop UI design notes |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | React UI + client boundary (see `src/AGENTS.md`) |
| `src-tauri/` | Tauri/Rust shell + command bridge (see `src-tauri/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- `src` is UI/client-only via `DesktopAgentClient`.
- `src-tauri` owns native handlers, session access, snapshot parsing only — no direct workspace mutation from the shell beyond defined commands.
- Keep the mock desktop client first-class (scaffold/demo).
- Tauri command names + payload shapes are shared contracts: update `src/lib/agent-client.ts`, `src/lib/desktop-command-schemas.ts`, `src-tauri/src/lib.rs` / `desktop_commands.rs`, and tests together.
- Parse every native response with Zod before rendering.
- Redact user-visible event text, approval previews, command output, credential-like strings.

### Testing Requirements
- React: `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run desktop:test`
- Rust: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` (or `nx run desktop:tauri-test`)
- Session-log or command changes require **both** TS and Rust test runs.

### Common Patterns
- Colocated `App*.test.tsx`, `src/lib/*.test.ts`, Rust tests in `src-tauri/src/*tests*.rs` and `lib.rs`.

## Dependencies

### Internal
- `@mission-control/protocol` — schemas/types for events/sessions
- `@mission-control/core` — limited shared helpers (not runtime ownership in UI)
- `@mission-control/config` — product constants

### External
- `react`, `react-dom`, `@vitejs/plugin-react`, `vite`
- `@tauri-apps/api` ^2
- `zod`
- Rust: Tauri 2 (see `src-tauri/Cargo.toml`)

<!-- MANUAL: -->
