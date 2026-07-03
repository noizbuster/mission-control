//! Token counting via tiktoken-rs.
//!
//! Two encodings are supported, selected by the model string passed from JS:
//!
//!   - `O200kBase` — GPT-4o / o1 / GPT-5 (the modern OpenAI default).
//!   - `Cl100kBase` — GPT-3.5 / GPT-4 / older models.
//!
//! `o200k_base` is the default for any unrecognized model. Anthropic does not
//! publish a tokenizer, so either encoding is an approximation for Claude
//! (within ~5-10% across English/code text); `o200k_base` is the closer default
//! for current frontier models.
//!
//! Both BPE tables are embedded in the binary via tiktoken-rs. Encoders are
//! built lazily on first use and reused thereafter. Initialization never
//! panics: if a table fails to build the error surfaces through napi-rs as a
//! JS `Error`, and the table build is retried on the next call.
//!
//! Approach adapted from oh-my-pi (MIT, (c) 2025 Mario Zechner, 2025-2026 Can
//! Boluk) `crates/pi-natives/src/tokens.rs`, reimplemented without
//! `unwrap`/`expect`/`panic` to satisfy the crate's deny lints.

use std::sync::LazyLock;

use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use tiktoken_rs::{CoreBPE, cl100k_base, o200k_base};

/// Internal tokenizer encoding selector. Not exported across the N-API
/// boundary; the JS surface takes a model string instead.
enum Encoding {
    /// GPT-4o / o1 / GPT-5 (default).
    O200kBase,
    /// GPT-3.5 / GPT-4 / older.
    Cl100kBase,
}

/// Embed the o200k_base BPE table. Built once on first use. `None` records a
/// build failure without panicking; the failure surfaces as a napi `Error` and
/// the build is retried on the next request.
static O200K: LazyLock<Option<CoreBPE>> = LazyLock::new(|| o200k_base().ok());

/// Embed the cl100k_base BPE table. Same lazy/panic-free strategy as `O200K`.
static CL100K: LazyLock<Option<CoreBPE>> = LazyLock::new(|| cl100k_base().ok());

/// Resolve the encoder for `encoding`, or surface a napi `Error` when the
/// backing table failed to initialize.
fn encoder_for(encoding: Encoding) -> Result<&'static CoreBPE> {
    let table = match encoding {
        Encoding::O200kBase => &O200K,
        Encoding::Cl100kBase => &CL100K,
    };
    table
        .as_ref()
        .ok_or_else(|| Error::from_reason("failed to initialize BPE rank table"))
}

/// Pick an encoding from a model id. `o200k_base` is the default for any model
/// that is not clearly in the cl100k family. Model matching is intentionally
/// coarse: it is a budget approximation, not an exact tokenizer contract.
fn select_encoding(model: &str) -> Encoding {
    let lower = model.to_ascii_lowercase();
    if lower.contains("gpt-4o")
        || lower.contains("gpt-5")
        || lower.contains("o1")
        || lower.contains("o3")
        || lower.contains("o4-mini")
    {
        return Encoding::O200kBase;
    }
    if lower.contains("gpt-3.5") || lower.contains("gpt-4") || lower.contains("gpt-3") {
        return Encoding::Cl100kBase;
    }
    Encoding::O200kBase
}

/// Count tokens in `text` using the BPE table selected by `model`.
///
/// Uses ordinary encoding (no special-token handling), the right choice for
/// measuring user/model content rather than wire-protocol tokens. Empty input
/// returns `0`. An unrecognized model defaults to `o200k_base`. Never panics:
/// initialization or encoding failures surface as a JS `Error` via napi-rs.
#[napi]
pub fn count_tokens(text: String, model: String) -> Result<u32> {
    let encoding = select_encoding(&model);
    let bpe = encoder_for(encoding)?;
    Ok(bpe.encode_ordinary(&text).len() as u32)
}
