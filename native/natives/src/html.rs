//! HTML to Markdown conversion exported over N-API, accelerating the
//! `webfetch` HTML body path.
//!
//! Single entry point:
//!   - [`html_to_markdown`] converts an HTML string to CommonMark-flavoured
//!     Markdown using `html-to-markdown-rs`, with optional content cleaning
//!     (navigation/forms stripped) and image skipping.
//!
//! The crate never touches the network or the filesystem: callers hand it an
//! already-fetched HTML body. Path safety is not this module's concern. The
//! TypeScript wrapper falls back to the raw body (or a JS turndown path) when
//! the addon is absent or the conversion errors.
//!
//! Adapted from oh-my-pi's `crates/pi-natives/src/html.rs` (MIT,
//! (c) 2025 Mario Zechner, 2025-2026 Can Boluk). The oh-my-pi version dispatches
//! onto a libuv worker via a `task::blocking` helper; mission-control's crate is
//! sync-only (no `tokio_rt` feature), so this is a synchronous `#[napi]`.
//!
//! No `unwrap` / `expect` / `panic`: conversion failures map to a napi `Error`;
//! empty input returns an empty string.

use html_to_markdown_rs::{ConversionOptions, PreprocessingOptions, PreprocessingPreset, convert};
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;

/// Options for [`html_to_markdown`]. Field names are snake_case on the Rust
/// side and surface as camelCase over the N-API boundary.
#[napi(object)]
pub struct HtmlToMarkdownOptions {
    /// Strip navigation, forms, headers, and footers before conversion.
    pub clean_content: Option<bool>,
    /// Omit `<img>` elements from the Markdown output.
    pub skip_images: Option<bool>,
}

/// Convert `html` to Markdown. Malformed HTML is handled best-effort by the
/// underlying converter (it never panics); a genuine conversion failure
/// surfaces as a napi `Error` so the TypeScript caller can fall back to the
/// raw body.
#[napi]
pub fn html_to_markdown(html: String, opts: Option<HtmlToMarkdownOptions>) -> Result<String> {
    let resolved = opts.unwrap_or(HtmlToMarkdownOptions {
        clean_content: None,
        skip_images: None,
    });
    let skip_images = resolved.skip_images.unwrap_or(false);
    let clean_content = resolved.clean_content.unwrap_or(false);
    html_to_markdown_inner(&html, skip_images, clean_content).map_err(Error::from_reason)
}

/// Pure conversion core. Kept free of napi types so unit tests can exercise it
/// without linking Node N-API symbols (see the grep module for the rationale).
fn html_to_markdown_inner(
    html: &str,
    skip_images: bool,
    clean_content: bool,
) -> std::result::Result<String, String> {
    let conversion_opts = ConversionOptions {
        skip_images,
        preprocessing: PreprocessingOptions {
            enabled: clean_content,
            preset: PreprocessingPreset::Aggressive,
            remove_navigation: true,
            remove_forms: true,
        },
        // html-to-markdown-rs 3.x exposes more fields than the oh-my-pi 2.x
        // reference; `..Default::default()` keeps the converter's tuned
        // defaults for everything we do not override.
        ..Default::default()
    };
    convert(html, Some(conversion_opts))
        .map(|result| result.content.unwrap_or_default())
        .map_err(|err| format!("HTML to Markdown conversion failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_simple_html_to_markdown() {
        let md = html_to_markdown_inner(
            "<h1>Title</h1><p>Hello <strong>world</strong></p>",
            false,
            false,
        )
        .expect("simple html converts");
        assert!(md.contains("Title"));
        assert!(md.contains("world"));
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let md = html_to_markdown_inner("", false, false).expect("empty converts");
        assert!(md.is_empty());
    }

    #[test]
    fn malformed_html_does_not_panic() {
        // Unclosed tag and stray bracket: best-effort, must not crash.
        let md = html_to_markdown_inner("<broken", false, false);
        assert!(md.is_ok(), "malformed html must not error catastrophically");
    }

    #[test]
    fn skip_images_omits_img_elements() {
        let html = "<p>before</p><img src=\"x.png\" alt=\"pic\"><p>after</p>";
        let with_img = html_to_markdown_inner(html, false, false).expect("imgs kept");
        let no_img = html_to_markdown_inner(html, true, false).expect("imgs skipped");
        assert!(with_img.contains("x.png") || with_img.contains("pic"));
        assert!(!no_img.contains("x.png"));
    }
}
