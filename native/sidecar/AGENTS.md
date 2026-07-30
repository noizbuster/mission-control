<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# sidecar

## Purpose

Rust JSON Lines binary `mission-control-sidecar`. Speaks the versioned sidecar wire protocol with `packages/core` (`ProcessSidecarClient`): handshake, task run/cancel, shell sessions, PTY alloc, and workspace isolation resolve/diff. Optional process helper — core falls back to mock when the binary is missing, times out, or fails handshake.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Crate `mission-control-sidecar` (edition 2024, rust-version 1.88); bin path `src/main.rs` |
| `Cargo.lock` | Locked Rust deps (`tokio`, `serde_json`, `brush-core`, `portable-pty`, Windows `windows-sys`) |
| `project.json` | Nx project `sidecar`: `build` / `test` / `dev` via `cargo` on this manifest |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Binary modules and unit tests (see `src/AGENTS.md`) |
| `tests/` | Integration tests against `CARGO_BIN_EXE_mission-control-sidecar` (see `tests/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Wire schema must stay aligned with `packages/protocol/src/sidecar.ts` and `packages/core/src/native/sidecar-*.ts`.
- Protocol feature flags: `MCTRL_SIDECAR_V2=1`, `MCTRL_SIDECAR_V3=1` (see `SidecarProtocolOptions::from_env`).
- Clippy deny: `unwrap_used`, `expect_used`, `panic`; rustc deny `unsafe_op_in_unsafe_fn`, `unused_must_use`.
- Do not treat `target/` as source.

### Testing Requirements
- Unit: `cargo test --manifest-path native/sidecar/Cargo.toml`
- Nx: `nx run sidecar:test` / `nx run sidecar:build`
- Integration under `tests/` needs a built bin (`CARGO_BIN_EXE_mission-control-sidecar`).

### Common Patterns
- stdin JSONL commands → stdout JSONL responses; scheduler owns the loop.
- v1: `task.run`; v2 adds `task.cancel`; v3 adds `shell.session`, `pty.alloc`, `iso.resolve`.
- Windows-only session-control named-pipe proxy via argv `session-control-proxy`.

## Dependencies

### Internal
- `packages/protocol` — `SIDECAR_PROTOCOL_VERSION` / wire shapes
- `packages/core/src/native` — process client, wire parse, mock fallback
- `packages/core/src/agents/iso-client.ts` — iso.resolve/diff consumer
- `packages/core/src/runtime/session-control-owner-windows.ts` — Windows proxy consumer

### External
- `tokio`, `serde`/`serde_json`, `anyhow`
- `brush-core` / `brush-builtins` — stateful shell
- `portable-pty`, `os_pipe`, `libc`, `similar`
- `windows-sys` (Windows), `tempfile` (dev)

<!-- MANUAL: -->
