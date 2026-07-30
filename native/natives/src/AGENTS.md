<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

Rust modules behind the `mission-control-natives` N-API surface. Each module is a focused accelerator with panic-free error mapping; path policy and approval stay in TypeScript.

## Key Files

| File | Description |
|------|-------------|
| `lib.rs` | Crate root: module graph + architecture note (JS → N-API → Rust) |
| `tokens.rs` | `count_tokens(text, model)` — embedded `o200k_base` / `cl100k_base` via tiktoken-rs |
| `grep.rs` | `search` / `has_match` — ripgrep crates + rayon; uses `fs_cache` |
| `glob.rs` | `glob(pattern, root, opts)` — `ignore` walker + `globset`; brace fallback |
| `fd.rs` | `fuzzyFind(query, root, opts)` — fuzzy path discovery with denylist |
| `fs_cache.rs` | mtime-keyed content cache; `invalidate_fs_scan_cache()` N-API export |
| `ast.rs` | `ast_grep` / `ast_rewrite` (dry-run only) over six tree-sitter grammars |
| `summary.rs` | `summarize_code` — AST body/comment elision + optional BFS unfold |
| `html.rs` | `html_to_markdown` — webfetch body acceleration |
| `highlight.rs` | `highlight_code` — syntect ANSI utility (no disk I/O) |

## Subdirectories

None.

## For AI Agents

### Working In This Directory
- New exports: add `mod` in `lib.rs`, `#[napi]` entry, and mirror types in `natives-client.ts`.
- Grep/glob/ast/fd: never walk untrusted roots; trust caller path lists/roots.
- `ast_rewrite` must remain dry-run (no writes); TS applies patches through approval/mutation queue.
- `invalidate_fs_scan_cache` is the only wholesale cache clear — wire from workspace mutation success paths in core.
- Keep unit-testable `*_inner` helpers where N-API link symbols would break `cargo test` bins.
- Grammars supported for ast/summary: TypeScript, TSX, JavaScript, Python, Rust, Go.

### Testing Requirements
- Prefer pure Rust unit tests adjacent to logic (no napi runtime in test bins when avoided).
- Behavior contracts for load/fallback live in `packages/core/src/native/natives-client.test.ts`.

### Common Patterns
- Options structs: `#[napi(object)]` with `Option<…>` fields → JS camelCase.
- Soft-skip unreadable files in search/glob rather than failing the whole call.
- Default caps (e.g. glob max_results 100, walk timeouts) mirror TS tool defaults.

## Dependencies

### Internal
- Sibling modules (`grep` → `fs_cache`)
- TS consumer: `packages/core/src/native/natives-client.ts`

### External
- Per-module crates listed in parent `Cargo.toml` (tiktoken-rs, grep-*, ignore, globset, dashmap, tree-sitter*, ast-grep-core, html-to-markdown-rs, syntect, rayon, regex)

<!-- MANUAL: -->
