//! Syntax highlighting exported over N-API as an ANSI-colored utility.
//!
//! Single entry point:
//!   - [`highlight_code`] tokenises `text` with the `syntect` grammar selected
//!     by `lang` and emits ANSI-colored output using caller-supplied color
//!     escape sequences mapped to 11 semantic categories (comment, keyword,
//!     function, variable, string, number, type, operator, punctuation,
//!     inserted, deleted).
//!
//! The module is intentionally a pure utility: it performs no disk or network
//! access and is not yet wired into a tool. It exists so CLI renderers can pull
//! in-process highlighting later (the oh-my-pi equivalent drives TUI code
//! blocks). Exposing it now matches the task-8 port scope.
//!
//! Adapted from oh-my-pi's `crates/pi-natives/src/highlight.rs` (MIT,
//! (c) 2025 Mario Zechner, 2025-2026 Can Boluk). The scope-to-category mapping
//! table, the alias table, and the thread-local scope cache are reimplemented
//! against the same `syntect` 5.x API oh-my-pi uses, with the no-panic
//! `Scope::new` handling and a pure-inner split for `cargo test` linkability.
//!
//! No `unwrap` / `expect` / `panic`: `Scope::new` failures (malformed scope
//! literals at init) degrade to a skipped matcher rather than aborting, and an
//! unknown language falls back to plain text.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;

use napi::Result;
use napi_derive::napi;
use syntect::parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet};

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static SCOPE_MATCHERS: OnceLock<Option<ScopeMatchers>> = OnceLock::new();

thread_local! {
    static SCOPE_COLOR_CACHE: RefCell<HashMap<Scope, usize>> =
        RefCell::new(HashMap::with_capacity(256));
}

fn get_syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Pre-compiled scope literals for fast prefix matching. Each `Scope::new` can
/// fail only on a malformed literal, which is a programming error caught at
/// init. The whole struct is built behind a fallible constructor: if any
/// literal fails to parse (it cannot for the well-known TextMate scope names
/// used here), `SCOPE_MATCHERS` holds `None` and highlighting degrades to plain
/// text instead of panicking.
struct ScopeMatchers {
    comment: Scope,
    string: Scope,
    constant_character: Scope,
    meta_string: Scope,
    constant_numeric: Scope,
    constant_integer: Scope,
    constant: Scope,
    keyword: Scope,
    storage_type: Scope,
    storage_modifier: Scope,
    entity_name_function: Scope,
    support_function: Scope,
    meta_function_call: Scope,
    variable_function: Scope,
    entity_name_type: Scope,
    support_type: Scope,
    support_class: Scope,
    entity_name_class: Scope,
    entity_name_struct: Scope,
    entity_name_enum: Scope,
    entity_name_interface: Scope,
    entity_name_trait: Scope,
    keyword_operator: Scope,
    punctuation_accessor: Scope,
    punctuation: Scope,
    variable: Scope,
    entity_name: Scope,
    meta_path: Scope,
    markup_inserted: Scope,
    markup_deleted: Scope,
    meta_diff_header: Scope,
    meta_diff_range: Scope,
}

impl ScopeMatchers {
    /// Returns `None` only if a scope literal fails to parse. The literals are
    /// all standard TextMate scope names, so this always succeeds in practice;
    /// the `Option` keeps the no-panic contract honest.
    fn try_new() -> Option<Self> {
        let m = ScopeMatchersRaw::try_new()?;
        Some(Self {
            comment: m.comment,
            string: m.string,
            constant_character: m.constant_character,
            meta_string: m.meta_string,
            constant_numeric: m.constant_numeric,
            constant_integer: m.constant_integer,
            constant: m.constant,
            keyword: m.keyword,
            storage_type: m.storage_type,
            storage_modifier: m.storage_modifier,
            entity_name_function: m.entity_name_function,
            support_function: m.support_function,
            meta_function_call: m.meta_function_call,
            variable_function: m.variable_function,
            entity_name_type: m.entity_name_type,
            support_type: m.support_type,
            support_class: m.support_class,
            entity_name_class: m.entity_name_class,
            entity_name_struct: m.entity_name_struct,
            entity_name_enum: m.entity_name_enum,
            entity_name_interface: m.entity_name_interface,
            entity_name_trait: m.entity_name_trait,
            keyword_operator: m.keyword_operator,
            punctuation_accessor: m.punctuation_accessor,
            punctuation: m.punctuation,
            variable: m.variable,
            entity_name: m.entity_name,
            meta_path: m.meta_path,
            markup_inserted: m.markup_inserted,
            markup_deleted: m.markup_deleted,
            meta_diff_header: m.meta_diff_header,
            meta_diff_range: m.meta_diff_range,
        })
    }
}

struct ScopeMatchersRaw {
    comment: Scope,
    string: Scope,
    constant_character: Scope,
    meta_string: Scope,
    constant_numeric: Scope,
    constant_integer: Scope,
    constant: Scope,
    keyword: Scope,
    storage_type: Scope,
    storage_modifier: Scope,
    entity_name_function: Scope,
    support_function: Scope,
    meta_function_call: Scope,
    variable_function: Scope,
    entity_name_type: Scope,
    support_type: Scope,
    support_class: Scope,
    entity_name_class: Scope,
    entity_name_struct: Scope,
    entity_name_enum: Scope,
    entity_name_interface: Scope,
    entity_name_trait: Scope,
    keyword_operator: Scope,
    punctuation_accessor: Scope,
    punctuation: Scope,
    variable: Scope,
    entity_name: Scope,
    meta_path: Scope,
    markup_inserted: Scope,
    markup_deleted: Scope,
    meta_diff_header: Scope,
    meta_diff_range: Scope,
}

impl ScopeMatchersRaw {
    fn try_new() -> Option<Self> {
        // Collect each scope or fail fast (None) so the caller degrades to plain text.
        let comment = Scope::new("comment").ok()?;
        let string = Scope::new("string").ok()?;
        let constant_character = Scope::new("constant.character").ok()?;
        let meta_string = Scope::new("meta.string").ok()?;
        let constant_numeric = Scope::new("constant.numeric").ok()?;
        let constant_integer = Scope::new("constant.integer").ok()?;
        let constant = Scope::new("constant").ok()?;
        let keyword = Scope::new("keyword").ok()?;
        let storage_type = Scope::new("storage.type").ok()?;
        let storage_modifier = Scope::new("storage.modifier").ok()?;
        let entity_name_function = Scope::new("entity.name.function").ok()?;
        let support_function = Scope::new("support.function").ok()?;
        let meta_function_call = Scope::new("meta.function-call").ok()?;
        let variable_function = Scope::new("variable.function").ok()?;
        let entity_name_type = Scope::new("entity.name.type").ok()?;
        let support_type = Scope::new("support.type").ok()?;
        let support_class = Scope::new("support.class").ok()?;
        let entity_name_class = Scope::new("entity.name.class").ok()?;
        let entity_name_struct = Scope::new("entity.name.struct").ok()?;
        let entity_name_enum = Scope::new("entity.name.enum").ok()?;
        let entity_name_interface = Scope::new("entity.name.interface").ok()?;
        let entity_name_trait = Scope::new("entity.name.trait").ok()?;
        let keyword_operator = Scope::new("keyword.operator").ok()?;
        let punctuation_accessor = Scope::new("punctuation.accessor").ok()?;
        let punctuation = Scope::new("punctuation").ok()?;
        let variable = Scope::new("variable").ok()?;
        let entity_name = Scope::new("entity.name").ok()?;
        let meta_path = Scope::new("meta.path").ok()?;
        let markup_inserted = Scope::new("markup.inserted").ok()?;
        let markup_deleted = Scope::new("markup.deleted").ok()?;
        let meta_diff_header = Scope::new("meta.diff.header").ok()?;
        let meta_diff_range = Scope::new("meta.diff.range").ok()?;
        Some(Self {
            comment,
            string,
            constant_character,
            meta_string,
            constant_numeric,
            constant_integer,
            constant,
            keyword,
            storage_type,
            storage_modifier,
            entity_name_function,
            support_function,
            meta_function_call,
            variable_function,
            entity_name_type,
            support_type,
            support_class,
            entity_name_class,
            entity_name_struct,
            entity_name_enum,
            entity_name_interface,
            entity_name_trait,
            keyword_operator,
            punctuation_accessor,
            punctuation,
            variable,
            entity_name,
            meta_path,
            markup_inserted,
            markup_deleted,
            meta_diff_header,
            meta_diff_range,
        })
    }
}

fn get_scope_matchers() -> Option<&'static ScopeMatchers> {
    SCOPE_MATCHERS.get_or_init(ScopeMatchers::try_new).as_ref()
}

/// Theme colors for syntax highlighting. Each value is an ANSI escape sequence
/// (e.g. `"\x1b[38;2;255;0;0m"`). The `type` field is raw-identifiers (`r#type`)
/// on the Rust side and surfaces as `type` over the N-API boundary.
#[napi(object)]
pub struct HighlightColors {
    pub comment: String,
    pub keyword: String,
    pub function: String,
    pub variable: String,
    pub string: String,
    pub number: String,
    pub r#type: String,
    pub operator: String,
    pub punctuation: String,
    pub inserted: Option<String>,
    pub deleted: Option<String>,
}

/// `(aliases, target syntax name)` pairs for languages whose name/extension is
/// not directly in syntect's default set. Mirrors oh-my-pi's table.
const LANG_ALIASES: &[(&[&str], &str)] = &[
    (&["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
    (&["py", "python"], "Python"),
    (&["rb", "ruby"], "Ruby"),
    (&["rs", "rust"], "Rust"),
    (&["go", "golang"], "Go"),
    (&["java"], "Java"),
    (&["kt", "kotlin"], "Java"),
    (&["swift"], "Objective-C"),
    (&["c", "h"], "C"),
    (&["cpp", "cc", "cxx", "c++", "hpp", "hxx", "hh"], "C++"),
    (&["cs", "csharp"], "C#"),
    (&["php"], "PHP"),
    (&["sh", "bash", "zsh", "shell"], "Bash"),
    (&["ps1", "powershell"], "PowerShell"),
    (&["html", "htm", "astro", "vue", "svelte"], "HTML"),
    (&["css"], "CSS"),
    (&["scss"], "SCSS"),
    (&["sass"], "Sass"),
    (&["less"], "LESS"),
    (&["json"], "JSON"),
    (&["yaml", "yml"], "YAML"),
    (&["toml"], "TOML"),
    (&["xml"], "XML"),
    (&["md", "markdown"], "Markdown"),
    (&["sql"], "SQL"),
    (&["lua"], "Lua"),
    (&["perl", "pl", "pm"], "Perl"),
    (&["r"], "R"),
    (&["scala"], "Scala"),
    (&["clj", "clojure"], "Clojure"),
    (&["el", "elisp", "emacs-lisp", "emacslisp"], "Lisp"),
    (&["ex", "exs", "elixir"], "Ruby"),
    (&["erl", "erlang"], "Erlang"),
    (&["hs", "haskell"], "Haskell"),
    (&["ml", "ocaml"], "OCaml"),
    (&["vim"], "VimL"),
    (&["graphql", "gql"], "GraphQL"),
    (&["proto", "protobuf"], "Protocol Buffers"),
    (&["tf", "hcl", "terraform"], "Terraform"),
    (&["dockerfile", "docker", "containerfile"], "Dockerfile"),
    (&["makefile", "make", "just", "justfile"], "Makefile"),
    (&["cmake", "cmakelists"], "CMake"),
    (&["ini", "cfg", "conf", "config", "properties"], "INI"),
    (&["diff", "patch"], "Diff"),
    (&["gitignore", "gitattributes", "gitmodules"], "Git Ignore"),
];

#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
    LANG_ALIASES
        .iter()
        .find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
        .map(|(_, target)| *target)
}

fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
    if let Some(syn) = ss.find_syntax_by_token(lang) {
        return Some(syn);
    }
    if let Some(syn) = ss.find_syntax_by_extension(lang) {
        return Some(syn);
    }
    let alias = find_alias(lang)?;
    ss.find_syntax_by_name(alias).or_else(|| ss.find_syntax_by_token(alias))
}

#[inline]
fn compute_scope_color(s: Scope) -> usize {
    let Some(m) = get_scope_matchers() else {
        return usize::MAX;
    };
    if m.comment.is_prefix_of(s) {
        return 0;
    }
    if m.markup_inserted.is_prefix_of(s) {
        return 9;
    }
    if m.markup_deleted.is_prefix_of(s) {
        return 10;
    }
    if m.meta_diff_header.is_prefix_of(s) || m.meta_diff_range.is_prefix_of(s) {
        return 1;
    }
    if m.string.is_prefix_of(s) || m.constant_character.is_prefix_of(s) || m.meta_string.is_prefix_of(s) {
        return 4;
    }
    if m.constant_numeric.is_prefix_of(s) || m.constant_integer.is_prefix_of(s) {
        return 5;
    }
    if m.keyword.is_prefix_of(s) || m.storage_type.is_prefix_of(s) || m.storage_modifier.is_prefix_of(s) {
        return 1;
    }
    if m.entity_name_function.is_prefix_of(s)
        || m.support_function.is_prefix_of(s)
        || m.meta_function_call.is_prefix_of(s)
        || m.variable_function.is_prefix_of(s)
    {
        return 2;
    }
    if m.entity_name_type.is_prefix_of(s)
        || m.support_type.is_prefix_of(s)
        || m.support_class.is_prefix_of(s)
        || m.entity_name_class.is_prefix_of(s)
        || m.entity_name_struct.is_prefix_of(s)
        || m.entity_name_enum.is_prefix_of(s)
        || m.entity_name_interface.is_prefix_of(s)
        || m.entity_name_trait.is_prefix_of(s)
    {
        return 6;
    }
    if m.keyword_operator.is_prefix_of(s) || m.punctuation_accessor.is_prefix_of(s) {
        return 7;
    }
    if m.punctuation.is_prefix_of(s) {
        return 8;
    }
    if m.variable.is_prefix_of(s) || m.entity_name.is_prefix_of(s) || m.meta_path.is_prefix_of(s) {
        return 3;
    }
    if m.constant.is_prefix_of(s) {
        return 5;
    }
    usize::MAX
}

#[inline]
fn scope_to_color_index(scope: &ScopeStack) -> usize {
    SCOPE_COLOR_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        for s in scope.as_slice().iter().rev() {
            let color_idx = *cache.entry(*s).or_insert_with(|| compute_scope_color(*s));
            if color_idx != usize::MAX {
                return color_idx;
            }
        }
        usize::MAX
    })
}

const RESET: &str = "\x1b[39m";

/// Highlight `code` with the grammar selected by `lang` and wrap each token in
/// the matching caller color. Unknown languages fall back to plain text (no
/// ANSI codes). Parse errors append the offending line unhighlighted and
/// continue, so the call never fails on malformed input.
#[napi]
pub fn highlight_code(code: String, lang: String, colors: HighlightColors) -> Result<String> {
    let palette = Palette::from_colors(&colors);
    Ok(highlight_code_inner(&code, &lang, &palette))
}

struct Palette {
    slots: [String; 11],
}

impl Palette {
    fn from_colors(colors: &HighlightColors) -> Self {
        let inserted = colors.inserted.clone().unwrap_or_default();
        let deleted = colors.deleted.clone().unwrap_or_default();
        let slots = [
            colors.comment.clone(),
            colors.keyword.clone(),
            colors.function.clone(),
            colors.variable.clone(),
            colors.string.clone(),
            colors.number.clone(),
            colors.r#type.clone(),
            colors.operator.clone(),
            colors.punctuation.clone(),
            inserted,
            deleted,
        ];
        Self { slots }
    }
}

fn highlight_code_inner(code: &str, lang: &str, palette: &Palette) -> String {
    let ss = get_syntax_set();
    let syntax = find_syntax(ss, lang).unwrap_or_else(|| ss.find_syntax_plain_text());
    highlight_with_syntax(code, ss, syntax, palette)
}

fn highlight_with_syntax(
    code: &str,
    ss: &SyntaxSet,
    syntax: &SyntaxReference,
    palette: &Palette,
) -> String {
    let mut parse_state = ParseState::new(syntax);
    let mut scope_stack = ScopeStack::new();
    let mut result = String::with_capacity(code.len() * 2);
    for line in syntect::util::LinesWithEndings::from(code) {
        let ops = match parse_state.parse_line(line, ss) {
            Ok(ops) => ops,
            Err(_) => {
                result.push_str(line);
                continue;
            }
        };
        let mut prev_end = 0;
        for (offset, op) in ops {
            let offset = offset.min(line.len());
            if offset > prev_end {
                emit_segment(&line[prev_end..offset], &scope_stack, palette, &mut result);
            }
            prev_end = offset;
            match op {
                ScopeStackOp::Push(scope) => scope_stack.push(scope),
                ScopeStackOp::Pop(count) => {
                    for _ in 0..count {
                        scope_stack.pop();
                    }
                }
                ScopeStackOp::Restore | ScopeStackOp::Clear(_) | ScopeStackOp::Noop => {}
            }
        }
        if prev_end < line.len() {
            emit_segment(&line[prev_end..], &scope_stack, palette, &mut result);
        }
    }
    result
}

fn emit_segment(text: &str, scope: &ScopeStack, palette: &Palette, out: &mut String) {
    let color_idx = scope_to_color_index(scope);
    if color_idx < palette.slots.len() {
        let color = &palette.slots[color_idx];
        if !color.is_empty() {
            out.push_str(color);
            out.push_str(text);
            out.push_str(RESET);
            return;
        }
    }
    out.push_str(text);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palette() -> Palette {
        Palette {
            slots: [
                "\x1b[38;2;120;120;120m".to_string(), // comment
                "\x1b[38;2;255;0;128m".to_string(),   // keyword
                "\x1b[38;2;0;128;255m".to_string(),   // function
                "\x1b[38;2;200;200;200m".to_string(), // variable
                "\x1b[38;2;0;200;0m".to_string(),     // string
                "\x1b[38;2;200;200;0m".to_string(),   // number
                "\x1b[38;2;128;128;255m".to_string(), // type
                "\x1b[38;2;255;128;0m".to_string(),   // operator
                "\x1b[38;2;160;160;160m".to_string(), // punctuation
                String::new(),                        // inserted
                String::new(),                        // deleted
            ],
        }
    }

    #[test]
    fn returns_plain_text_for_unknown_language() {
        let out = highlight_code_inner("const x = 1;", "totally-unknown-lang", &palette());
        // No ANSI escape sequences when the language is unsupported.
        assert!(!out.contains("\x1b["));
        assert!(out.contains("const x = 1;"));
    }

    #[test]
    fn highlights_typescript_snippet_with_ansi() {
        let out = highlight_code_inner("const x = 1;", "typescript", &palette());
        assert!(out.contains("\x1b["), "expected ANSI codes for a highlighted TS snippet");
        assert!(out.contains("const"));
    }

    #[test]
    fn alias_ts_maps_to_javascript_grammar() {
        let ts_out = highlight_code_inner("const x = 1;", "ts", &palette());
        let js_out = highlight_code_inner("const x = 1;", "js", &palette());
        assert_eq!(ts_out, js_out, "ts and js should resolve to the same grammar");
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let out = highlight_code_inner("", "rust", &palette());
        assert!(out.is_empty());
    }

    #[test]
    fn malformed_code_does_not_panic() {
        let out = highlight_code_inner("function {{{{\n", "typescript", &palette());
        assert!(out.contains("function"));
    }

    #[test]
    fn find_alias_resolves_known_tokens() {
        assert_eq!(find_alias("ts"), Some("JavaScript"));
        assert_eq!(find_alias("RUST"), Some("Rust"));
        assert_eq!(find_alias("brainfuck"), None);
    }
}
