<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

Rust implementation of the desktop Tauri app: entrypoints, registered commands, command bridge/stream, and session-log reading with header/event/sequence/timestamp invariants.

## Key Files

| File | Description |
|------|-------------|
| `main.rs` | Binary entry (delegates to lib) |
| `lib.rs` | Tauri builder, registered command names, shared Rust tests |
| `desktop_commands.rs` | Command handler implementations |
| `desktop_command_bridge.rs` | Bridge between UI invokes and command execution |
| `desktop_command_bridge_stream.rs` | Streaming bridge path |
| `sessions.rs` | Session header/event reading and invariants |
| `desktop_command_test_support.rs` | Shared Rust test support |
| `desktop_command_tests.rs` | Command unit/integration tests |
| `desktop_command_approval_tests.rs` | Approval command tests |
| `desktop_command_run_owner_tests.rs` | Run-owner command tests |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Register new commands in `lib.rs` and implement in `desktop_commands.rs` / bridge modules; update TS client + Zod schemas in lockstep.
- Session parsing must enforce sequence/timestamp invariants; keep corrupt/empty fixtures covered.
- Fallible APIs: return `Result`, never panic in production paths.
- Test support stays in `desktop_command_test_support.rs`.

### Testing Requirements
- Inline/module tests above + `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.
- Approval and run-owner behaviors have dedicated test files.

### Common Patterns
- Serde DTOs at the command boundary; validate before side effects.
- Bridge separates invoke plumbing from domain handlers.

## Dependencies

### Internal
- `../tauri.conf.json` product config
- Contracts mirrored by `apps/desktop/src/lib/desktop-*-schemas.ts`

### External
- `tauri`, `serde`, `serde_json`, and crates from parent `Cargo.toml`

<!-- MANUAL: -->
