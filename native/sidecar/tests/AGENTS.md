<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# tests

## Purpose

Integration tests that spawn the real `mission-control-sidecar` binary (`env!("CARGO_BIN_EXE_mission-control-sidecar")`) and drive JSONL over stdin/stdout. Complements in-crate `src/*_tests.rs` unit coverage.

## Key Files

| File | Description |
|------|-------------|
| `shell_cancellation.rs` | End-to-end v3 handshake + `stream_open` shell session; asserts cancel path stops an external `sleep` before a late marker file is written |

## Subdirectories

None.

## For AI Agents

### Working In This Directory
- Tests require a built bin; `cargo test` for this package builds `CARGO_BIN_EXE_mission-control-sidecar`.
- Enable protocol flags in the child env: `MCTRL_SIDECAR_V2=1`, `MCTRL_SIDECAR_V3=1` when exercising v3 shell streams.
- Keep fixtures under `tempfile::TempDir`; do not write into the repo tree.
- Prefer asserting observable process/FS effects (marker files, handshake lines) over internal module state.

### Testing Requirements
- `cargo test --manifest-path native/sidecar/Cargo.toml`
- Integration tests are slower and timing-sensitive; avoid tightening sleeps without cause.

### Common Patterns
- Spawn with piped stdio → write handshake JSON line → read `handshake_completed` → open stream / cancel → assert.

## Dependencies

### Internal
- Binary under test: `native/sidecar` (`mission-control-sidecar`)
- Protocol shapes from `src/protocol.rs` (informally mirrored as raw JSON in tests)

### External
- `std::process::Command`, `tempfile` (dev-dep on crate)

<!-- MANUAL: -->
