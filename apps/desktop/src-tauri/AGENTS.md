<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src-tauri

## Purpose

Tauri v2 native shell for Mission Control desktop: Rust command bridge, session-log reading/invariants, and Node helper scripts used by desktop command/session tooling. Build artifacts under `target/` are generated — do not edit. `test-fixtures/` is skipped for AGENTS content.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Rust package manifest for the Tauri app |
| `Cargo.lock` | Locked Rust deps (commit; do not casually churn) |
| `tauri.conf.json` | Product metadata + Vite build hooks |
| `desktop-command-service.mjs` | Node helper for desktop command service paths |
| `desktop-session-queries.mjs` | Node helper for session query helpers |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Rust sources: lib/main, commands, sessions, bridge (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- No `unwrap` / `expect` / `panic` in Rust production paths (Cargo lints deny).
- Do not edit `target/`.
- Keep command surface stable with TS `desktop-command-schemas` + `agent-client`.
- `.mjs` helpers are Node-side support for tests/tooling — not the webview bundle.

### Testing Requirements
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- Pair with `nx run desktop:test` when commands/session shapes change.

### Common Patterns
- Tauri command handlers thin; parsing/invariants in dedicated modules.

## Dependencies

### Internal
- Session logs / data dir conventions from product runtime
- Mirrors contracts in `apps/desktop/src/lib`

### External
- Tauri 2, serde, and other crates in `Cargo.toml`

<!-- MANUAL: -->
