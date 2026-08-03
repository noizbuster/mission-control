//! mission-control-natives: N-API native addon for performance-critical primitives.
//!
//! The first export is `count_tokens`, a BPE-backed token counter for budget
//! estimates. Both `o200k_base` (GPT-4o / o1 / GPT-5) and `cl100k_base`
//! (GPT-3.5 / GPT-4) rank tables are embedded in the binary, so counting needs
//! no network access. The addon is optional: when the `.node` artifact is
//! absent or fails to load, the TypeScript wrapper in
//! `packages/core/src/native/natives-client.ts` falls back to `null` and emits
//! a `native.warning`, and the run continues.
//!
//! Architecture: JS (`packages/core`) -> N-API -> Rust modules (`tokens`).

mod ast;
mod fd;
mod fs_cache;
mod glob;
mod grep;
mod highlight;
mod html;
mod session_debug;
mod summary;
mod tokens;
