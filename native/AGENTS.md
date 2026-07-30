<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# native

## Purpose

Rust native components outside the pnpm workspace graph (except metadata). Houses the JSON Lines sidecar binary (`mission-control-sidecar`) used for shell/PTY execution and the N-API cdylib (`mission-control-natives`) that accelerates grep/glob/AST/token/highlight paths for core tools. TypeScript must not import sidecar internals; wire stays on the versioned JSONL protocol.

## Key Files

No crate at this directory root. Children each have `Cargo.toml`, `Cargo.lock`, and Nx `project.json`.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `sidecar/` | Rust JSONL sidecar binary + integration tests (see `sidecar/AGENTS.md`) |
| `natives/` | N-API native addon (cdylib) for FS/AST acceleration (see `natives/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Sidecar binary name: `mission-control-sidecar`. Protocol version is shared with `packages/protocol/src/sidecar.ts` (`SIDECAR_PROTOCOL_VERSION`).
- Do not make sidecar depend on TypeScript runtime internals.
- Clippy denies `unwrap`/`expect`/`panic` in production code; prefer `anyhow` + explicit error paths.
- Keep `Cargo.lock` committed unless deliberately bumping deps.
- `natives` is not a pnpm workspace member today; `package.json` is release-distribution metadata (optional platform packages).

### Testing Requirements
- Sidecar: `cargo test --manifest-path native/sidecar/Cargo.toml` or `nx run sidecar:test`
- Natives: `cargo test --manifest-path native/natives/Cargo.toml` or `nx run natives:test`
- Root `tests/native-artifact-contract.test.ts` locks artifact/layout expectations.
- Dev sidecar: `pnpm dev:sidecar` → `cargo run --manifest-path native/sidecar/Cargo.toml --`

### Common Patterns
- Edition 2024; sidecar rust-version 1.88, natives 1.85.
- Sidecar: tokio multi-thread, serde_json lines on stdio, portable-pty / brush shell stack.
- Natives: `napi` 3 / `napi-derive`, tree-sitter 0.24 ABI line, ast-grep-core 0.36 (ABI-aligned).

## Dependencies

### Internal
- Protocol contract: `packages/protocol` sidecar schemas (TS) ↔ `sidecar/src/protocol.rs`
- Core client: `packages/core/src/native` spawns/handshakes the sidecar; optional natives load for tool acceleration
- Packaging: `scripts/package-cli.ts` bundles the release sidecar binary into `mctrl-<os>-<arch>.tar.gz`

### External
- Sidecar: anyhow, tokio, serde/serde_json, portable-pty, brush-core/builtins, similar, os_pipe, libc
- Natives: napi, tiktoken-rs, grep-*, ignore/globset, dashmap, tree-sitter + language crates, ast-grep-core, html-to-markdown-rs, syntect

<!-- MANUAL: -->
