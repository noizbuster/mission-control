<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# natives

## Purpose

Optional N-API (`napi` 3 / napi10) cdylib `mission-control-natives` accelerating hot repo/tool primitives: token count, grep/search, glob, fuzzy find, AST grep/rewrite, code summary, HTML→markdown, syntax highlight, mtime file-content cache. JS loads via `packages/core/src/native/natives-client.ts`; missing/failed `.node` → null client + `native.warning`, run continues.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Crate `mission-control-natives`, `crate-type = ["cdylib"]`, edition 2024, rust-version 1.85; tree-sitter 0.24 ABI pin notes |
| `Cargo.lock` | Locked native dependency graph |
| `build.rs` | `napi_build::setup()` |
| `package.json` | `@mission-control/natives` metadata + napi triples; **not** a pnpm workspace member (release-distribution stub) |
| `project.json` | Nx `natives`: `cargo build` / `cargo test` on this manifest |
| `index.node` | Built/prebuilt addon artifact consumed locally (large binary; do not hand-edit) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Rust N-API modules (see `src/AGENTS.md`) |
| `target/` | Cargo output — skip |

## For AI Agents

### Working In This Directory
- Addon is optional acceleration only; every export must remain safe when unloaded (TS fallbacks).
- Path safety stays in TypeScript (workspace guard, `temp/ref-repos` denylist). Rust accepts already-vetted absolute paths/roots and must not reintroduce traversal escapes.
- Single tree-sitter ABI line (0.24 / ABI 14): do not bump `ast-grep-core` past 0.36 or mix tree-sitter 0.25 without a coordinated grammar migration.
- Clippy deny unwrap/expect/panic; map failures to napi `Error` or soft skip.
- `index.node` / `target/` are build products.

### Testing Requirements
- `cargo test --manifest-path native/natives/Cargo.toml`
- `nx run natives:test` / `nx run natives:build`
- TS contract: `packages/core/src/native/natives-client.test.ts`; workspace `tests/native-artifact-contract.test.ts`

### Common Patterns
- `#[napi]` / `#[napi(object)]` exports; camelCase on the JS boundary.
- Env override for artifact path: `MCTRL_NATIVES_PATH`.
- Future multi-platform optional deps named in `package.json` (`@mission-control/natives-<os>-<arch>`).

## Dependencies

### Internal
- `packages/core/src/native/natives-client.ts` — loader and typed wrappers
- Tool runners under `packages/core/src/tools/` (grep/glob/ast/read/webfetch paths)

### External
- `napi` / `napi-derive` / `napi-build`
- `tiktoken-rs`, `grep-*`, `regex`, `rayon`, `ignore`, `globset`, `dashmap`
- `tree-sitter` + ts/tsx/js/python/go/rust grammars, `ast-grep-core` 0.36
- `html-to-markdown-rs`, `syntect`

<!-- MANUAL: -->
