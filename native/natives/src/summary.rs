//! Structural source summaries powered by tree-sitter, exported over N-API
//! and consumed by `repo.read` / `read` as the default "summarized snippets"
//! output.
//!
//! Single entry point:
//!   - [`summarize_code`] parses `code` with the tree-sitter grammar selected
//!     by `lang` (alias) or `path` (extension), walks the AST, and returns a
//!     sequence of kept/elided segments. Bodies and long comments that exceed
//!     `min_body_lines` / `min_comment_lines` are elided; consecutive import
//!     runs are collapsed between their boundary statements. An optional BFS
//!     unfold progressively re-reveals outer-then-inner spans up to a target
//!     visible-line count.
//!
//! Supported languages (minimum set required by the port): TypeScript, TSX,
//! JavaScript, Python, Rust, Go. Any other language, an unparseable source,
//! or an empty input returns `parsed: false` with the verbatim source as a
//! single kept segment, so the TypeScript caller can fall back to raw text.
//!
//! Path safety is not this module's concern: `repo.read` resolves and vets
//! the path through the workspace guard first, then hands the already-read
//! file CONTENT to `summarize_code`. The summary never touches the disk.
//!
//! The elision algorithm is adapted from oh-my-pi's
//! `crates/pi-ast/src/summary.rs` (MIT, (c) 2025 Mario Zechner,
//! 2025-2026 Can Boluk): the elidable-forest collector, the groupable-run
//! flusher, the BFS unfold, and the per-language node-kind tables are
//! reimplemented against raw tree-sitter (no ast-grep bridge) for the six
//! grammars above.
//!
//! No `unwrap` / `expect` / `panic`: every fallible op maps to a napi
//! `Error` (language load) or degrades to the unparsed fallback (parse
//! failure), matching the crate-wide no-panic contract.

use std::collections::BTreeSet;

use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use tree_sitter::{Language, Node, Parser};

const DEFAULT_MIN_BODY_LINES: u32 = 4;
const DEFAULT_MIN_COMMENT_LINES: u32 = 6;

/// Options for [`summarize_code`]. Field names are snake_case on the Rust
/// side and surface as camelCase over the N-API boundary.
#[napi(object)]
pub struct SummaryOptions {
    /// Source code to summarize.
    pub code: String,
    /// Language alias (e.g. "typescript", "tsx", "rust") used before path
    /// inference.
    pub lang: Option<String>,
    /// File path used to infer language by extension when `lang` is omitted.
    pub path: Option<String>,
    /// Minimum total node lines before eliding a body/literal node.
    pub min_body_lines: Option<u32>,
    /// Minimum total comment lines before eliding a multiline block comment.
    pub min_comment_lines: Option<u32>,
    /// Target visible-line count for BFS unfold. `None` or `0` keeps only the
    /// outermost elisions (no progressive unfolding).
    pub unfold_until_lines: Option<u32>,
    /// Hard ceiling for BFS unfold. Defaults to `unfold_until_lines * 2`.
    pub unfold_limit_lines: Option<u32>,
}

#[napi(object)]
pub struct SummarySegment {
    /// "kept" or "elided".
    pub kind: String,
    /// 1-based inclusive start line.
    pub start_line: u32,
    /// 1-based inclusive end line.
    pub end_line: u32,
    /// Verbatim text for kept segments; absent for elided segments.
    pub text: Option<String>,
}

#[napi(object)]
pub struct SummaryResult {
    /// Canonical language name when parsing succeeded.
    pub language: Option<String>,
    /// True when tree-sitter parsed the source without syntax errors.
    pub parsed: bool,
    /// True when at least one elision span was emitted.
    pub elided: bool,
    /// Total source lines.
    pub total_lines: u32,
    /// Kept/elided segments in source order.
    pub segments: Vec<SummarySegment>,
}

// ---------------------------------------------------------------------------
// Pure inner types (no napi symbols) so `cargo test` links without Node.
// ---------------------------------------------------------------------------

struct SummaryOptionsInner {
    code: String,
    lang: Option<String>,
    path: Option<String>,
    min_body_lines: Option<u32>,
    min_comment_lines: Option<u32>,
    unfold_until_lines: Option<u32>,
    unfold_limit_lines: Option<u32>,
}

struct SummarySegmentInner {
    kind: String,
    start_line: u32,
    end_line: u32,
    text: Option<String>,
}

struct SummaryResultInner {
    language: Option<String>,
    parsed: bool,
    elided: bool,
    total_lines: u32,
    segments: Vec<SummarySegmentInner>,
}

// ---------------------------------------------------------------------------
// Language dispatch (raw tree-sitter, no ast-grep bridge).
// ---------------------------------------------------------------------------

/// One of the supported grammars. Variants carry their canonical name and the
/// `Language` resolved lazily via [`resolve_language`].
#[derive(Clone, Copy, PartialEq, Eq)]
enum SupportLang {
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Rust,
    Go,
}

impl SupportLang {
    fn canonical_name(self) -> &'static str {
        match self {
            SupportLang::TypeScript => "typescript",
            SupportLang::Tsx => "tsx",
            SupportLang::JavaScript => "javascript",
            SupportLang::Python => "python",
            SupportLang::Rust => "rust",
            SupportLang::Go => "go",
        }
    }

    fn ts_language(self) -> Language {
        match self {
            SupportLang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            SupportLang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            SupportLang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            SupportLang::Python => tree_sitter_python::LANGUAGE.into(),
            SupportLang::Rust => tree_sitter_rust::LANGUAGE.into(),
            SupportLang::Go => tree_sitter_go::LANGUAGE.into(),
        }
    }
}

/// Resolve a language from an explicit alias, falling back to the file
/// extension. Mirrors oh-my-pi's `resolve_language` precedence.
fn resolve_language(lang: Option<&str>, path: Option<&str>) -> Option<SupportLang> {
    if let Some(lang) = lang.map(str::trim).filter(|lang| !lang.is_empty()) {
        return alias_to_lang(lang);
    }
    let path = path?.trim();
    if path.is_empty() {
        return None;
    }
    extension_to_lang(path)
}

fn alias_to_lang(alias: &str) -> Option<SupportLang> {
    match alias.to_ascii_lowercase().as_str() {
        "typescript" | "ts" => Some(SupportLang::TypeScript),
        "tsx" => Some(SupportLang::Tsx),
        "javascript" | "js" | "jsx" => Some(SupportLang::JavaScript),
        "python" | "py" => Some(SupportLang::Python),
        "rust" | "rs" => Some(SupportLang::Rust),
        "go" | "golang" => Some(SupportLang::Go),
        _ => None,
    }
}

fn extension_to_lang(path: &str) -> Option<SupportLang> {
    let ext = path.rsplit('.').next()?;
    match ext {
        "ts" => Some(SupportLang::TypeScript),
        "tsx" => Some(SupportLang::Tsx),
        "js" | "jsx" | "mjs" | "cjs" => Some(SupportLang::JavaScript),
        "py" => Some(SupportLang::Python),
        "rs" => Some(SupportLang::Rust),
        "go" => Some(SupportLang::Go),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Line-span bookkeeping.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LineSpan {
    start: u32,
    end: u32,
}

impl LineSpan {
    const fn lines(self) -> u32 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

/// One elidable region plus its directly-nested elidable descendants. The
/// forest is built by AST traversal in source order, so a child's span is
/// always strictly contained within its parent's.
struct SpanNode {
    span: LineSpan,
    children: Vec<usize>,
}

#[derive(Default)]
struct ElidableForest {
    nodes: Vec<SpanNode>,
    roots: Vec<usize>,
}

impl ElidableForest {
    fn push(&mut self, parent: Option<usize>, span: LineSpan) -> usize {
        let idx = self.nodes.len();
        self.nodes.push(SpanNode {
            span,
            children: Vec::new(),
        });
        match parent {
            Some(p) => self.nodes[p].children.push(idx),
            None => self.roots.push(idx),
        }
        idx
    }
}

// ---------------------------------------------------------------------------
// N-API entry point + pure inner.
// ---------------------------------------------------------------------------

/// Summarize `code` into kept/elided segments using the tree-sitter grammar
/// selected by `lang` or `path`. Unsupported languages, parse errors, and
/// empty input return `parsed: false` with the verbatim source as a single
/// kept segment so the caller can fall back to raw text.
#[napi]
pub fn summarize_code(opts: SummaryOptions) -> Result<SummaryResult> {
    let inner = SummaryOptionsInner {
        code: opts.code,
        lang: opts.lang,
        path: opts.path,
        min_body_lines: opts.min_body_lines,
        min_comment_lines: opts.min_comment_lines,
        unfold_until_lines: opts.unfold_until_lines,
        unfold_limit_lines: opts.unfold_limit_lines,
    };
    summarize_code_inner(&inner)
        .map_err(Error::from_reason)
        .map(map_result)
}

fn map_result(value: SummaryResultInner) -> SummaryResult {
    SummaryResult {
        language: value.language,
        parsed: value.parsed,
        elided: value.elided,
        total_lines: value.total_lines,
        segments: value
            .segments
            .into_iter()
            .map(|seg| SummarySegment {
                kind: seg.kind,
                start_line: seg.start_line,
                end_line: seg.end_line,
                text: seg.text,
            })
            .collect(),
    }
}

/// Pure summarization core. Returns the inner result or a `String` error
/// (language load failure). Kept free of napi types so unit tests can
/// exercise it without linking Node N-API symbols.
fn summarize_code_inner(opts: &SummaryOptionsInner) -> std::result::Result<SummaryResultInner, String> {
    let source = &opts.code;
    let total_lines = count_lines(source);
    if source.is_empty() {
        return Ok(unparsed_result(total_lines));
    }

    let Some(language) = resolve_language(opts.lang.as_deref(), opts.path.as_deref()) else {
        return Ok(unparsed_result_with_source(source, total_lines));
    };

    let mut parser = Parser::new();
    parser
        .set_language(&language.ts_language())
        .map_err(|err| format!("Failed to load tree-sitter language: {err}"))?;
    let Some(tree) = parser.parse(source.as_bytes(), None) else {
        return Ok(unparsed_result_with_source(source, total_lines));
    };
    let root = tree.root_node();
    if root.has_error() {
        return Ok(unparsed_result_with_source(source, total_lines));
    }

    let min_body_lines = opts.min_body_lines.unwrap_or(DEFAULT_MIN_BODY_LINES).max(2);
    let min_comment_lines = opts.min_comment_lines.unwrap_or(DEFAULT_MIN_COMMENT_LINES).max(4);
    let unfold_until = opts.unfold_until_lines.unwrap_or(0);
    let unfold_limit = opts
        .unfold_limit_lines
        .unwrap_or_else(|| unfold_until.saturating_mul(2));
    let mut forest = ElidableForest::default();
    collect_elidable_tree(root, None, language, min_body_lines, min_comment_lines, &mut forest);
    let spans = select_folded_spans(&forest, total_lines, unfold_until, unfold_limit);
    let spans = normalize_spans(spans, total_lines);
    let segments = build_segments(source, total_lines, &spans);

    Ok(SummaryResultInner {
        language: Some(language.canonical_name().to_string()),
        parsed: true,
        elided: !spans.is_empty(),
        total_lines,
        segments,
    })
}

fn unparsed_result(total_lines: u32) -> SummaryResultInner {
    SummaryResultInner {
        language: None,
        parsed: false,
        elided: false,
        total_lines,
        segments: Vec::new(),
    }
}

fn unparsed_result_with_source(source: &str, total_lines: u32) -> SummaryResultInner {
    let segments = if total_lines == 0 {
        Vec::new()
    } else {
        vec![SummarySegmentInner {
            kind: "kept".to_string(),
            start_line: 1,
            end_line: total_lines,
            text: Some(source.to_string()),
        }]
    };
    SummaryResultInner {
        language: None,
        parsed: false,
        elided: false,
        total_lines,
        segments,
    }
}

fn count_lines(source: &str) -> u32 {
    if source.is_empty() {
        0
    } else {
        source.lines().count().max(1).min(u32::MAX as usize) as u32
    }
}

// ---------------------------------------------------------------------------
// Elidable-span collection (adapted from oh-my-pi pi-ast/summary.rs, MIT).
// ---------------------------------------------------------------------------

fn collect_elidable_tree(
    node: Node<'_>,
    elidable_parent: Option<usize>,
    language: SupportLang,
    min_body_lines: u32,
    min_comment_lines: u32,
    forest: &mut ElidableForest,
) {
    let total_lines = node_line_count(node);
    if is_comment_kind(language, node.kind()) {
        if total_lines >= min_comment_lines {
            let start_line = node_start_line(node) + 2;
            let end_line = node_end_line(node).saturating_sub(1);
            if start_line <= end_line {
                forest.push(elidable_parent, LineSpan { start: start_line, end: end_line });
            }
        }
        return;
    }

    let mut current_parent = elidable_parent;
    if is_elidable_kind(language, node.kind()) && total_lines >= min_body_lines {
        let start_line = node_start_line(node) + 1;
        let end_line = node_end_line(node).saturating_sub(1);
        if start_line <= end_line {
            // Recurse into the elided node so nested elisions are recorded as
            // children; the BFS unfold pass decides which level fires.
            current_parent =
                Some(forest.push(elidable_parent, LineSpan { start: start_line, end: end_line }));
        }
    }

    // Detect consecutive runs of groupable siblings (e.g. import statements).
    // When the run's total span meets `min_body_lines`, elide the lines
    // strictly between the first and last sibling's content, leaving the
    // boundary statements visible.
    let child_count = node.child_count();
    let mut run_first: Option<Node<'_>> = None;
    let mut run_last: Option<Node<'_>> = None;
    let mut run_count: u32 = 0;
    for index in 0..child_count {
        let Some(child) = node.child(index) else { continue };
        if is_groupable_kind(language, child.kind()) {
            if run_first.is_none() {
                run_first = Some(child);
            }
            run_last = Some(child);
            run_count += 1;
        } else {
            flush_groupable_run(run_first, run_last, run_count, min_body_lines, forest, current_parent);
            run_first = None;
            run_last = None;
            run_count = 0;
        }
    }
    flush_groupable_run(run_first, run_last, run_count, min_body_lines, forest, current_parent);

    for index in 0..child_count {
        if let Some(child) = node.child(index) {
            collect_elidable_tree(child, current_parent, language, min_body_lines, min_comment_lines, forest);
        }
    }
}

fn flush_groupable_run(
    first: Option<Node<'_>>,
    last: Option<Node<'_>>,
    count: u32,
    min_body_lines: u32,
    forest: &mut ElidableForest,
    parent: Option<usize>,
) {
    if count < 2 {
        return;
    }
    let (Some(first), Some(last)) = (first, last) else {
        return;
    };
    let first_start = node_start_line(first);
    let last_start = node_start_line(last);
    let last_end = node_end_line(last);
    let span_lines = last_end.saturating_sub(first_start).saturating_add(1);
    if span_lines < min_body_lines {
        return;
    }
    // Use the line of the first node's last visible content as the lower
    // bound; some grammars include a trailing newline in the node range,
    // which would otherwise place `end_line` on the next sibling's line.
    let first_content_end = node_content_end_line(first).min(last_start.saturating_sub(1));
    let start = first_content_end.saturating_add(1);
    let end = last_start.saturating_sub(1);
    if start <= end {
        forest.push(parent, LineSpan { start, end });
    }
}

fn node_start_line(node: Node<'_>) -> u32 {
    node.start_position().row.saturating_add(1).min(u32::MAX as usize) as u32
}

fn node_end_line(node: Node<'_>) -> u32 {
    node.end_position().row.saturating_add(1).min(u32::MAX as usize) as u32
}

/// Last source line containing a content byte from `node`. Tree-sitter
/// reports `end_position` one past the last byte; when that byte is a newline
/// the position lands at column 0 of the next row, which would otherwise
/// over-count by one.
fn node_content_end_line(node: Node<'_>) -> u32 {
    let pos = node.end_position();
    let row = if pos.column == 0 && pos.row > 0 {
        pos.row - 1
    } else {
        pos.row
    };
    row.saturating_add(1).min(u32::MAX as usize) as u32
}

fn node_line_count(node: Node<'_>) -> u32 {
    node_end_line(node)
        .saturating_sub(node_start_line(node))
        .saturating_add(1)
}

fn is_comment_kind(language: SupportLang, kind: &str) -> bool {
    match language {
        SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript | SupportLang::Go => {
            kind == "comment"
        }
        SupportLang::Rust => kind == "block_comment",
        SupportLang::Python => kind == "comment",
    }
}

fn is_elidable_kind(language: SupportLang, kind: &str) -> bool {
    match language {
        SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => matches!(
            kind,
            "statement_block"
                | "function_body"
                | "object"
                | "array"
                | "template_string"
                | "class_body"
                | "interface_body"
                | "enum_body"
                | "object_type"
                | "switch_body"
                | "jsx_element"
                | "jsx_self_closing_element"
        ),
        SupportLang::Rust => matches!(
            kind,
            "block"
                | "array_expression"
                | "tuple_expression"
                | "struct_expression"
                | "match_block"
                | "raw_string_literal"
                | "declaration_list"
                | "field_declaration_list"
                | "ordered_field_declaration_list"
                | "enum_variant_list"
                | "where_clause"
                | "use_list"
                | "macro_definition"
                | "token_tree"
        ),
        SupportLang::Python => matches!(
            kind,
            "block"
                | "dictionary"
                | "list"
                | "set"
                | "string"
                | "tuple"
                | "argument_list"
                | "parameters"
                | "parenthesized_expression"
                | "list_comprehension"
                | "set_comprehension"
                | "dictionary_comprehension"
                | "generator_expression"
                | "import_from_statement"
                | "subscript"
        ),
        SupportLang::Go => matches!(
            kind,
            "block"
                | "composite_literal"
                | "interpreted_string_literal"
                | "raw_string_literal"
                | "import_spec_list"
                | "const_declaration"
                | "var_declaration"
                | "field_declaration_list"
                | "interface_type"
                | "expression_switch_statement"
                | "type_switch_statement"
                | "select_statement"
        ),
    }
}

fn is_groupable_kind(language: SupportLang, kind: &str) -> bool {
    match language {
        SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => {
            kind == "import_statement"
        }
        SupportLang::Rust => matches!(kind, "use_declaration" | "extern_crate_declaration"),
        SupportLang::Python => {
            matches!(kind, "import_statement" | "import_from_statement" | "future_import_statement")
        }
        SupportLang::Go => kind == "import_declaration",
    }
}

// ---------------------------------------------------------------------------
// BFS unfold (adapted from oh-my-pi, MIT).
// ---------------------------------------------------------------------------

/// Start with every root span folded and progressively replace folded spans
/// with their elidable children, breadth-first, until the visible line count
/// reaches `unfold_until`. A candidate whose revealed lines would push the
/// visible count past `unfold_limit` is skipped so a single oversized leaf
/// cannot starve its siblings. `unfold_until == 0` short-circuits to the
/// outermost-only behavior.
fn select_folded_spans(
    forest: &ElidableForest,
    total_lines: u32,
    unfold_until: u32,
    unfold_limit: u32,
) -> Vec<LineSpan> {
    use std::collections::{HashSet, VecDeque};

    let nodes = &forest.nodes;
    let mut folded: HashSet<usize> = forest.roots.iter().copied().collect();
    if unfold_until == 0 || folded.is_empty() {
        return folded.into_iter().map(|i| nodes[i].span).collect();
    }

    let folded_line_total: u32 = folded.iter().map(|&i| nodes[i].span.lines()).sum();
    let mut visible = total_lines.saturating_sub(folded_line_total);
    let mut queue: VecDeque<usize> = forest.roots.iter().copied().collect();

    while let Some(idx) = queue.pop_front() {
        if visible >= unfold_until {
            break;
        }
        if !folded.contains(&idx) {
            continue;
        }
        let node = &nodes[idx];
        let child_line_total: u32 = node.children.iter().map(|&c| nodes[c].span.lines()).sum();
        let revealed = node.span.lines().saturating_sub(child_line_total);
        let new_visible = visible.saturating_add(revealed);
        if new_visible > unfold_limit {
            continue;
        }
        folded.remove(&idx);
        for &c in &node.children {
            folded.insert(c);
            queue.push_back(c);
        }
        visible = new_visible;
    }

    folded.into_iter().map(|i| nodes[i].span).collect()
}

fn normalize_spans(mut spans: Vec<LineSpan>, total_lines: u32) -> Vec<LineSpan> {
    if total_lines == 0 {
        return Vec::new();
    }
    spans.retain(|span| span.start <= span.end && span.start <= total_lines);
    for span in &mut spans {
        span.end = span.end.min(total_lines);
    }
    spans.sort_by_key(|span| (span.start, span.end));
    let mut merged: Vec<LineSpan> = Vec::new();
    for span in spans {
        if let Some(last) = merged.last_mut()
            && span.start <= last.end.saturating_add(1)
        {
            last.end = last.end.max(span.end);
            continue;
        }
        merged.push(span);
    }
    merged
}

fn build_segments(source: &str, total_lines: u32, spans: &[LineSpan]) -> Vec<SummarySegmentInner> {
    if total_lines == 0 {
        return Vec::new();
    }
    let source_lines: Vec<&str> = source.lines().collect();
    let elided_lines = spans
        .iter()
        .flat_map(|span| span.start..=span.end)
        .collect::<BTreeSet<_>>();
    let mut segments = Vec::new();
    let mut current_kind: Option<&str> = None;
    let mut current_start = 1;
    let mut current_lines: Vec<&str> = Vec::new();

    for line_number in 1..=total_lines {
        let is_elided = elided_lines.contains(&line_number);
        let kind = if is_elided { "elided" } else { "kept" };
        if let Some(existing) = current_kind
            && existing != kind
        {
            push_segment(&mut segments, existing, current_start, line_number - 1, &current_lines);
            current_start = line_number;
            current_lines.clear();
        }
        current_kind = Some(kind);
        if !is_elided {
            let index = line_number.saturating_sub(1) as usize;
            current_lines.push(source_lines.get(index).copied().unwrap_or_default());
        }
    }

    if let Some(kind) = current_kind {
        push_segment(&mut segments, kind, current_start, total_lines, &current_lines);
    }
    segments
}

fn push_segment(
    segments: &mut Vec<SummarySegmentInner>,
    kind: &str,
    start_line: u32,
    end_line: u32,
    lines: &[&str],
) {
    segments.push(SummarySegmentInner {
        kind: kind.to_string(),
        start_line,
        end_line,
        text: (kind == "kept").then(|| lines.join("\n")),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summarize(code: &str, path: &str) -> SummaryResultInner {
        summarize_code_inner(&SummaryOptionsInner {
            code: code.to_string(),
            lang: None,
            path: Some(path.to_string()),
            min_body_lines: None,
            min_comment_lines: None,
            unfold_until_lines: None,
            unfold_limit_lines: None,
        })
        .expect("summary succeeds")
    }

    fn segment_kinds(result: &SummaryResultInner) -> Vec<&str> {
        result.segments.iter().map(|s| s.kind.as_str()).collect()
    }

    #[test]
    fn empty_input_is_unparsed() {
        let result = summarize("", "fixture.ts");
        assert!(!result.parsed);
        assert!(!result.elided);
        assert_eq!(result.total_lines, 0);
        assert!(result.segments.is_empty());
    }

    #[test]
    fn unsupported_language_falls_back_to_verbatim() {
        let result = summarize("plain text\nwith lines\n", "fixture.xyz");
        assert!(!result.parsed);
        assert!(!result.elided);
        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.segments[0].text.as_deref(), Some("plain text\nwith lines\n"));
    }

    #[test]
    fn parse_error_falls_back_to_unparsed() {
        let result = summarize("export function broken( {\n", "fixture.ts");
        assert!(!result.parsed);
        assert!(!result.elided);
        assert_eq!(result.segments.len(), 1);
    }

    #[test]
    fn summarizes_typescript_function_body() {
        let result = summarize(
            "export function greet(name: string): string {\n\tconst clean = name.trim();\n\tconst \
             label = clean || 'world';\n\treturn `hello ${label}`;\n}\n",
            "fixture.ts",
        );
        assert!(result.parsed);
        assert!(result.elided);
        assert_eq!(result.language.as_deref(), Some("typescript"));
        assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
        assert_eq!(
            result.segments[0].text.as_deref(),
            Some("export function greet(name: string): string {")
        );
        assert_eq!(result.segments[1].start_line, 2);
        assert_eq!(result.segments[1].end_line, 4);
        assert_eq!(result.segments[2].text.as_deref(), Some("}"));
    }

    #[test]
    fn summarizes_tsx_function_body() {
        let result = summarize(
            "export function Card(props: { title: string }): JSX.Element {\n\tconst a = props.title;\n\t\
             const b = a.toLowerCase();\n\tconst c = b.trim();\n\treturn <div>{c}</div>;\n}\n",
            "fixture.tsx",
        );
        assert!(result.parsed);
        assert!(result.elided);
        assert_eq!(result.language.as_deref(), Some("tsx"));
        assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
    }

    #[test]
    fn summarizes_rust_method_body() {
        let result = summarize(
            "struct Greeter;\n\nimpl Greeter {\n\tfn greet(&self) -> String {\n\t\tlet name = \
             \"world\";\n\t\tlet label = name.to_uppercase();\n\t\tformat!(\"hello {label}\")\n\t}\n}\n",
            "fixture.rs",
        );
        assert!(result.parsed);
        assert!(result.elided);
        let rendered = result
            .segments
            .iter()
            .map(|s| s.text.clone().unwrap_or_else(|| "...".to_string()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("impl Greeter {"));
        assert!(rendered.contains("..."));
        assert!(rendered.contains("}"));
    }

    #[test]
    fn summarizes_python_class_body() {
        let result = summarize(
            "class Greeter:\n    def greet(self, name: str) -> str:\n        clean = \
             name.strip()\n        label = clean or 'world'\n        return f'hello {label}'\n",
            "fixture.py",
        );
        assert!(result.parsed);
        assert!(result.elided);
        assert_eq!(result.language.as_deref(), Some("python"));
        assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
    }

    #[test]
    fn summarizes_go_function_body() {
        let result = summarize(
            "package main\n\nfunc greet(name string) string {\n\tclean := strings.TrimSpace(name)\n\t\
             label := clean\n\tif label == \"\" {\n\t\tlabel = \"world\"\n\t}\n\treturn \"hello \" + label\n}\n",
            "fixture.go",
        );
        assert!(result.parsed);
        assert!(result.elided);
        assert_eq!(result.language.as_deref(), Some("go"));
        let kept = result
            .segments
            .iter()
            .filter(|s| s.kind == "kept")
            .map(|s| s.text.as_deref().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(kept.contains("func greet"));
    }

    #[test]
    fn summarizes_typescript_import_run() {
        let code = "import a from \"a\";\nimport b from \"b\";\nimport c from \"c\";\nimport d \
                    from \"d\";\nimport e from \"e\";\nimport f from \"f\";\n\nexport function main() {}\n";
        let result = summarize(code, "fixture.ts");
        assert!(result.parsed);
        assert!(result.elided);
        let elided = result
            .segments
            .iter()
            .find(|s| s.kind == "elided")
            .expect("elided segment");
        assert_eq!(elided.start_line, 2);
        assert_eq!(elided.end_line, 5);
        assert!(
            result.segments[0]
                .text
                .as_deref()
                .unwrap_or_default()
                .starts_with("import a from")
        );
    }

    #[test]
    fn short_body_is_not_elided() {
        let result = summarize("function small() {\n\treturn 1;\n}\n", "fixture.ts");
        assert!(result.parsed);
        assert!(!result.elided);
    }

    #[test]
    fn alias_overrides_path_extension() {
        let result = summarize(
            "export function greet(): string {\n\tconst a = 1;\n\tconst b = 2;\n\tconst c = 3;\n\treturn \"hi\";\n}\n",
            "fixture.txt",
        );
        // No lang -> .txt is unsupported -> unparsed.
        assert!(!result.parsed);
        assert!(!result.elided);

        let result = summarize_code_inner(&SummaryOptionsInner {
            code: "export function greet(): string {\n\tconst a = 1;\n\tconst b = 2;\n\tconst \
                   c = 3;\n\treturn \"hi\";\n}\n"
                .to_string(),
            lang: Some("typescript".to_string()),
            path: Some("fixture.txt".to_string()),
            min_body_lines: None,
            min_comment_lines: None,
            unfold_until_lines: None,
            unfold_limit_lines: None,
        })
        .expect("summary succeeds");
        assert!(result.parsed);
        assert!(result.elided);
        assert_eq!(result.language.as_deref(), Some("typescript"));
    }

    #[test]
    fn malformed_input_does_not_panic() {
        // Garbage that is syntactically near-code but unparseable: best-effort,
        // no panic.
        let result = summarize("function {{{{\n", "fixture.ts");
        assert!(!result.parsed);
        // Even fully-malformed input must not panic and must return a result.
        let result = summarize("\n\n\n@@@ not code @@@\n", "fixture.py");
        assert!(result.segments.len() <= 1);
    }
}
