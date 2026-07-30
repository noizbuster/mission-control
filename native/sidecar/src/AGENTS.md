<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

Implementation of `mission-control-sidecar`: JSONL scheduler loop, protocol encode/decode, brush shell sessions, PTY allocation, workspace isolation PAL, shell cancellation registry, and Windows session-control named-pipe proxy.

## Key Files

| File | Description |
|------|-------------|
| `main.rs` | Entry: `session-control-proxy` argv → proxy; else `scheduler::run` (tokio multi-thread, 2 workers) |
| `scheduler.rs` | Stdin line loop; dispatches handshake / run_task / cancel / stream_open|close / iso_*; owns shell + PTY stores |
| `protocol.rs` | `SidecarCommand` / responses; v1–v3 capability sets; `MCTRL_SIDECAR_V2`/`V3` options |
| `protocol_tests.rs` | Parse/serialize coverage for handshake, tasks, streams, iso envelopes |
| `shell.rs` | `ShellSessionStore` — persistent `brush_core::Shell` by `sessionId`; stream frames; 30s default timeout; 256KB raw capture backstop |
| `shell_cancellation.rs` | Per-session `Notify` registry for cooperative cancel of active shell commands |
| `shell_tests.rs` | Session env persistence and shell run behavior |
| `pty.rs` | `PtySessionStore` — `portable-pty` alloc; 64KB output cap; 4KB frame chunks; default 30s timeout |
| `pty_tests.rs` | PTY alloc/stream and cap behavior |
| `iso.rs` | Workspace isolation PAL: Linux overlayfs/fuse-overlayfs/rcopy, macOS APFS clone/rcopy, else unsupported; `iso.resolve` / `iso.diff`; mount cleanup on stdin EOF |
| `iso_tests.rs` | Platform-dispatch unit tests (incl. unsupported path) |
| `session_control_pipe.rs` | Cross-platform bootstrap/registry helpers; `SESSION_CONTROL_PROXY_MODE`; non-Windows stub |
| `session_control_pipe_tests.rs` | Proxy mode argv, pipe name, registry JSON |
| `session_control_pipe_windows.rs` | Windows named-pipe server proxy (`cfg(windows)`) |
| `session_control_pipe_windows_security.rs` | Current-user SDDL/DACL helpers for pipe + registry dir |

## Subdirectories

None.

## For AI Agents

### Working In This Directory
- Keep response helpers (`handshake_completed_response_for_version`, `task_*`, `stream_frame_response`, `iso_*`) the single serialization surface.
- Shell/PTY containment caps (timeout, output) must stay consistent with TS tool wrappers (`packages/core` bash/pty clients).
- Iso: no panic on failure — return `method` strings (`overlayfs`, `rcopy`, `apfs`, `unsupported`, `failed:…`). Process-static mount registry torn down in scheduler exit path.
- Windows modules are `cfg(windows)`; do not force-link them on Unix builds.
- Prefer mapping errors to protocol `task_failed` / empty iso resolution over aborting the process.

### Testing Requirements
- Module `*_tests.rs` files are compiled with the crate (`cargo test --manifest-path native/sidecar/Cargo.toml`).
- PTY/shell tests are `tokio::test` and need a usable `/bin`/`PATH`.
- Process-level cancel lives in `../tests/shell_cancellation.rs`.

### Common Patterns
- Stream envelope: `SidecarStreamFrame` seq payloads from shell/PTY.
- `RunTask` label `"fail"` is the built-in failure fixture path in the scheduler.
- Shell cancellation: register → run → finish/cancel via `ShellCancellationRegistry`.

## Dependencies

### Internal
- Parent crate root / `../Cargo.toml`
- Wire contract: `packages/protocol/src/sidecar.ts`
- TS clients: `packages/core/src/native/sidecar-client.ts`, `sidecar-wire.ts`

### External
- Same as parent crate: tokio, serde_json, brush-*, portable-pty, os_pipe, similar, windows-sys

<!-- MANUAL: -->
