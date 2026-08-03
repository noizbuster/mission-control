//! ast-grep structural pattern matching and rewrite primitives, exported over
//! N-API and consumed by the `ast_grep` tool runner.
//!
//! Two entry points:
//!   - [`ast_grep`] runs one ast-grep pattern over a caller-vetted list of
//!     absolute file paths and returns the matches with 1-indexed positions.
//!   - [`ast_rewrite`] computes (dry-run) replacement changes for a pattern +
//!     replacement over the same path list, without writing to disk.
//!
//! Path safety stays on the TypeScript side, mirroring the `grep` module: the
//! caller resolves and vets the file list (workspace containment +
//! `temp/ref-repos` denylist) and hands the surviving absolute paths here. The
//! Rust side only reads and matches those exact files, so it cannot bypass the
//! guard. Directories are NOT walked by this module; the caller expands them.
//!
//! The matching engine is `ast-grep-core` over the same six tree-sitter
//! grammars the `summary` module pins to the 0.24 ABI line (TypeScript, TSX,
//! JavaScript, Python, Rust, Go). ast-grep-core 0.36 is the last release whose
//! tree-sitter requirement resolves to 0.24, keeping the whole crate on a
//! single native `tree-sitter` link. Note ast-grep-core 0.36 aliases its
//! `tree-sitter` dependency to the `tree-sitter-facade-sg` package, so the
//! `Pattern` type parameter is the facade `Language` (bridged from the real
//! grammar `LanguageFn` via the facade's `From<LanguageFn>` impl).
//!
//! Adapted from oh-my-pi's `crates/pi-natives/src/ast.rs` (MIT,
//! (c) 2025 Mario Zechner, 2025-2026 Can Boluk). The oh-my-pi version drives a
//! 50+ grammar catalog, a libuv worker, and an fs-cache; mission-control
//! collapses to the six in-tree grammars, a synchronous `#[napi]`, and the
//! grep-style path-guard delegation, and never writes files (the rewrite
//! primitive is dry-run only so the workspace guard + approval boundary stay in
//! TypeScript).
//!
//! No `unwrap` / `expect` / `panic`: `ast-grep-core`'s `Pattern::new` panics on
//! a malformed pattern, so this module routes through `Pattern::try_new`
//! (returns `Result<_, PatternError>`) and maps every failure to a napi `Error`
//! or a per-file parse-error string. Read/permission errors skip the file.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;

use ast_grep_core::Language as AstGrepLanguage;
use ast_grep_core::MatchStrictness;
use ast_grep_core::language::TSLanguage as SgLanguage;
use ast_grep_core::matcher::Pattern;
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;

const DEFAULT_MATCH_LIMIT: u32 = 50;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Options for [`ast_grep`]. Field names are snake_case on the Rust side and
/// surface as camelCase over the N-API boundary.
#[napi(object)]
pub struct AstGrepOptions {
    pub lang: Option<String>,
    pub selector: Option<String>,
    /// Pattern strictness. One of `cst`, `smart` (default), `ast`, `relaxed`,
    /// `signature`.
    pub strictness: Option<String>,
    pub include_meta: Option<bool>,
    pub limit: Option<u32>,
}

/// One ast-grep match. Positions are 1-indexed to match the TypeScript runner's
/// normalised output (sg emits 0-indexed; the runner adds 1).
#[napi(object)]
pub struct AstMatch {
    pub path: String,
    pub text: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub meta_variables: Option<HashMap<String, String>>,
}

/// Options for [`ast_rewrite`].
#[napi(object)]
pub struct AstRewriteOptions {
    pub replacement: String,
    pub lang: Option<String>,
    pub selector: Option<String>,
    pub strictness: Option<String>,
    pub max_replacements: Option<u32>,
}

/// One computed replacement (dry-run). The TypeScript caller decides whether to
/// apply it through the workspace mutation queue + approval boundary.
#[napi(object)]
pub struct AstReplaceChange {
    pub path: String,
    pub before: String,
    pub after: String,
    pub byte_start: u32,
    pub byte_end: u32,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// Result of [`ast_grep`]: the page of matches plus non-fatal parse/compile
/// diagnostics. Mirrors the fields the TypeScript runner consumes.
#[napi(object)]
pub struct AstGrepResult {
    pub matches: Vec<AstMatch>,
    pub files_searched: u32,
    pub files_with_matches: u32,
    pub limit_reached: bool,
    pub parse_errors: Option<Vec<String>>,
}

// Pure inner types (no napi symbols) so `cargo test` links without Node.

#[derive(Debug)]
struct AstGrepOptionsInner {
    lang: Option<String>,
    selector: Option<String>,
    strictness: Option<String>,
    include_meta: bool,
    limit: u32,
}

#[derive(Debug)]
struct AstMatchInner {
    path: String,
    text: String,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    meta_variables: Option<HashMap<String, String>>,
}

#[derive(Debug)]
struct AstGrepResultInner {
    matches: Vec<AstMatchInner>,
    files_searched: u32,
    files_with_matches: u32,
    limit_reached: bool,
    parse_errors: Vec<String>,
}

#[derive(Debug)]
struct AstReplaceChangeInner {
    path: String,
    before: String,
    after: String,
    byte_start: u32,
    byte_end: u32,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SupportLang {
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Rust,
    Go,
}

impl SupportLang {
    fn sg_language(self) -> SgLanguage {
        match self {
            SupportLang::TypeScript => {
                SgLanguage::from(tree_sitter_typescript::LANGUAGE_TYPESCRIPT)
            }
            SupportLang::Tsx => SgLanguage::from(tree_sitter_typescript::LANGUAGE_TSX),
            SupportLang::JavaScript => SgLanguage::from(tree_sitter_javascript::LANGUAGE),
            SupportLang::Python => SgLanguage::from(tree_sitter_python::LANGUAGE),
            SupportLang::Rust => SgLanguage::from(tree_sitter_rust::LANGUAGE),
            SupportLang::Go => SgLanguage::from(tree_sitter_go::LANGUAGE),
        }
    }
}

fn resolve_language(lang: Option<&str>, file_path: &Path) -> Option<SupportLang> {
    if let Some(lang) = lang.map(str::trim).filter(|l| !l.is_empty()) {
        return alias_to_lang(lang);
    }
    extension_to_lang(file_path)
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

fn extension_to_lang(path: &Path) -> Option<SupportLang> {
    let ext = path.extension()?.to_str()?;
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

fn language_name(lang: SupportLang) -> &'static str {
    match lang {
        SupportLang::TypeScript => "typescript",
        SupportLang::Tsx => "tsx",
        SupportLang::JavaScript => "javascript",
        SupportLang::Python => "python",
        SupportLang::Rust => "rust",
        SupportLang::Go => "go",
    }
}

fn parse_strictness(value: Option<&str>) -> std::result::Result<MatchStrictness, String> {
    match value.map(str::trim) {
        None | Some("") | Some("smart") => Ok(MatchStrictness::Smart),
        Some("cst") => Ok(MatchStrictness::Cst),
        Some("ast") => Ok(MatchStrictness::Ast),
        Some("relaxed") => Ok(MatchStrictness::Relaxed),
        Some("signature") => Ok(MatchStrictness::Signature),
        Some(other) => Err(format!(
            "Unknown ast-grep strictness '{other}'. Expected one of: cst, smart, ast, relaxed, signature."
        )),
    }
}

fn to_u32(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

// Pattern::new PANICS on a malformed pattern, so we route through try_new /
// contextual which return Result<_, PatternError>.

fn compile_pattern(
    pattern: &str,
    selector: Option<&str>,
    strictness: MatchStrictness,
    lang: SgLanguage,
) -> std::result::Result<Pattern<SgLanguage>, String> {
    let compiled = match selector.map(str::trim).filter(|s| !s.is_empty()) {
        Some(selector_str) => Pattern::contextual(pattern, selector_str, lang)
            .map_err(|err| format!("ast-grep pattern compile failed: {err}"))?,
        None => Pattern::try_new(pattern, lang)
            .map_err(|err| format!("ast-grep pattern compile failed: {err}"))?,
    };
    Ok(compiled.with_strictness(strictness))
}

#[napi]
pub fn ast_grep(
    pattern: String,
    paths: Vec<String>,
    opts: AstGrepOptions,
) -> Result<AstGrepResult> {
    let inner_opts = AstGrepOptionsInner {
        lang: opts.lang,
        selector: opts.selector,
        strictness: opts.strictness,
        include_meta: opts.include_meta.unwrap_or(false),
        limit: opts.limit.unwrap_or(DEFAULT_MATCH_LIMIT).max(1),
    };
    let result = ast_grep_inner(&pattern, &paths, &inner_opts).map_err(Error::from_reason)?;
    Ok(map_grep_result(result))
}

#[napi]
pub fn ast_rewrite(
    pattern: String,
    paths: Vec<String>,
    opts: AstRewriteOptions,
) -> Result<Vec<AstReplaceChange>> {
    let strictness = parse_strictness(opts.strictness.as_deref()).map_err(Error::from_reason)?;
    let max_replacements = opts.max_replacements.unwrap_or(u32::MAX).max(1) as usize;
    let lang_override = opts
        .lang
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    let changes = ast_rewrite_inner(
        &pattern,
        &opts.replacement,
        &paths,
        lang_override,
        opts.selector.as_deref(),
        strictness,
        max_replacements,
    )
    .map_err(Error::from_reason)?;
    Ok(changes
        .into_iter()
        .map(|c| AstReplaceChange {
            path: c.path,
            before: c.before,
            after: c.after,
            byte_start: c.byte_start,
            byte_end: c.byte_end,
            start_line: c.start_line,
            start_column: c.start_column,
            end_line: c.end_line,
            end_column: c.end_column,
        })
        .collect())
}

fn map_grep_result(value: AstGrepResultInner) -> AstGrepResult {
    AstGrepResult {
        matches: value
            .matches
            .into_iter()
            .map(|m| AstMatch {
                path: m.path,
                text: m.text,
                start_line: m.start_line,
                start_column: m.start_column,
                end_line: m.end_line,
                end_column: m.end_column,
                meta_variables: m.meta_variables,
            })
            .collect(),
        files_searched: value.files_searched,
        files_with_matches: value.files_with_matches,
        limit_reached: value.limit_reached,
        parse_errors: (!value.parse_errors.is_empty()).then_some(value.parse_errors),
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_compiled_pattern(
    compiled_by_lang: &mut HashMap<String, Pattern<SgLanguage>>,
    lang_key: &str,
    language: SupportLang,
    pattern: &str,
    selector: Option<&str>,
    strictness: MatchStrictness,
    parse_errors: &mut Vec<String>,
    path_label: &str,
) -> Option<Pattern<SgLanguage>> {
    if let Some(p) = compiled_by_lang.get(lang_key) {
        return Some(p.clone());
    }
    match compile_pattern(pattern, selector, strictness, language.sg_language()) {
        Ok(p) => {
            compiled_by_lang.insert(lang_key.to_string(), p.clone());
            Some(p)
        }
        Err(err) => {
            parse_errors.push(format!("{pattern}: {path_label}: {err}"));
            None
        }
    }
}

fn ast_grep_inner(
    pattern: &str,
    paths: &[String],
    opts: &AstGrepOptionsInner,
) -> std::result::Result<AstGrepResultInner, String> {
    let strictness = parse_strictness(opts.strictness.as_deref())?;
    let lang_override = opts
        .lang
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    if let Some(lang_str) = lang_override {
        if alias_to_lang(lang_str).is_none() {
            return Err(format!("Unsupported language '{lang_str}'"));
        }
    }
    let mut all_matches: Vec<AstMatchInner> = Vec::new();
    let mut parse_errors: Vec<String> = Vec::new();
    let mut files_searched = 0u32;
    let mut files_with_matches: BTreeSet<String> = BTreeSet::new();
    let limit = opts.limit as usize;
    let mut compiled_by_lang: HashMap<String, Pattern<SgLanguage>> = HashMap::new();

    for path_str in paths {
        let path = Path::new(path_str);
        let Some(language) = resolve_language(lang_override, path) else {
            continue;
        };
        let source = match read_file(path) {
            Some(source) => source,
            None => {
                parse_errors.push(format!("{pattern}: {path_str}: could not read file"));
                continue;
            }
        };
        files_searched = files_searched.saturating_add(1);

        let lang_key = language_name(language).to_string();
        let Some(compiled) = resolve_compiled_pattern(
            &mut compiled_by_lang,
            &lang_key,
            language,
            pattern,
            opts.selector.as_deref(),
            strictness.clone(),
            &mut parse_errors,
            path_str,
        ) else {
            continue;
        };

        let display_path = path_str.clone();
        let ast = language.sg_language().ast_grep(&source);
        if ast.root().dfs().any(|n| n.is_error()) {
            parse_errors.push(format!(
                "{pattern}: {display_path}: parse error (syntax tree contains error nodes)"
            ));
        }

        for matched in ast.root().find_all(compiled.clone()) {
            let start = matched.start_pos();
            let end = matched.end_pos();
            let meta_variables = if opts.include_meta {
                Some(HashMap::<String, String>::from(matched.get_env().clone()))
            } else {
                None
            };
            all_matches.push(AstMatchInner {
                path: display_path.clone(),
                text: matched.text().into_owned(),
                start_line: to_u32(start.line().saturating_add(1)),
                start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
                end_line: to_u32(end.line().saturating_add(1)),
                end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
                meta_variables,
            });
            files_with_matches.insert(display_path.clone());
        }
    }

    all_matches.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.start_column.cmp(&b.start_column))
    });
    let limit_reached = all_matches.len() > limit;
    if limit_reached {
        all_matches.truncate(limit);
    }

    Ok(AstGrepResultInner {
        matches: all_matches,
        files_searched,
        files_with_matches: to_u32(files_with_matches.len()),
        limit_reached,
        parse_errors,
    })
}

fn ast_rewrite_inner(
    pattern: &str,
    replacement: &str,
    paths: &[String],
    lang_override: Option<&str>,
    selector: Option<&str>,
    strictness: MatchStrictness,
    max_replacements: usize,
) -> std::result::Result<Vec<AstReplaceChangeInner>, String> {
    let mut changes: Vec<AstReplaceChangeInner> = Vec::new();
    let mut parse_errors: Vec<String> = Vec::new();
    let mut compiled_by_lang: HashMap<String, Pattern<SgLanguage>> = HashMap::new();

    for path_str in paths {
        if changes.len() >= max_replacements {
            break;
        }
        let path = Path::new(path_str);
        let Some(language) = resolve_language(lang_override, path) else {
            continue;
        };
        let source = match read_file(path) {
            Some(source) => source,
            None => {
                parse_errors.push(format!("{path_str}: could not read file"));
                continue;
            }
        };
        let lang_key = language_name(language).to_string();
        let Some(compiled) = resolve_compiled_pattern(
            &mut compiled_by_lang,
            &lang_key,
            language,
            pattern,
            selector,
            strictness.clone(),
            &mut parse_errors,
            path_str,
        ) else {
            continue;
        };

        let ast = language.sg_language().ast_grep(&source);
        for matched in ast.root().find_all(compiled.clone()) {
            if changes.len() >= max_replacements {
                break;
            }
            let edit = matched.replace_by(replacement);
            let range = matched.range();
            let start = matched.start_pos();
            let end = matched.end_pos();
            let after = String::from_utf8(edit.inserted_text)
                .map_err(|err| format!("replacement text is not valid UTF-8: {err}"))?;
            changes.push(AstReplaceChangeInner {
                path: path_str.clone(),
                before: matched.text().into_owned(),
                after,
                byte_start: to_u32(range.start),
                byte_end: to_u32(range.end),
                start_line: to_u32(start.line().saturating_add(1)),
                start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
                end_line: to_u32(end.line().saturating_add(1)),
                end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
            });
        }
    }
    let _ = parse_errors;
    Ok(changes)
}

fn read_file(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static FIXTURE_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn fixture_dir() -> PathBuf {
        let seq = FIXTURE_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("mc-natives-ast-{}-{}", std::process::id(), seq));
        stdfs::create_dir_all(&dir).ok();
        dir
    }

    fn write_fixture(dir: &Path, name: &str, contents: &str) -> String {
        let path = dir.join(name);
        stdfs::write(&path, contents).ok();
        path.to_string_lossy().into_owned()
    }

    fn opts(include_meta: bool) -> AstGrepOptionsInner {
        AstGrepOptionsInner {
            lang: None,
            selector: None,
            strictness: None,
            include_meta,
            limit: DEFAULT_MATCH_LIMIT,
        }
    }

    #[test]
    fn malformed_pattern_does_not_panic() {
        let dir = fixture_dir();
        let file = write_fixture(&dir, "a.ts", "const x = 1;\n");
        // A lone `(` compiles (ast-grep treats it as a malformed expression that
        // matches nothing) and must NOT panic; it returns Ok with zero matches.
        let ok_result = ast_grep_inner("(", &[file.clone()], &opts(false));
        assert!(
            ok_result.is_ok(),
            "lone paren must not panic: {ok_result:?}"
        );
        // A multi-statement pattern fails Pattern::try_new (MultipleNode). The
        // compile failure is collected as a non-fatal parse_error (matching sg's
        // stderr behavior) rather than a hard error, and must not panic.
        let err_result =
            ast_grep_inner("a(1); b(2);", &[file], &opts(false)).expect("no hard error");
        assert!(
            err_result
                .parse_errors
                .iter()
                .any(|e| e.contains("compile failed")),
            "multi-statement pattern must report a compile failure in parse_errors: {err_result:?}"
        );
        assert!(err_result.matches.is_empty());
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_console_log_in_typescript() {
        let dir = fixture_dir();
        let file = write_fixture(
            &dir,
            "a.ts",
            "console.log('hi');\nconst x = 1;\nconsole.log(x);\n",
        );
        let result = ast_grep_inner("console.log($X)", &[file.clone()], &opts(false))
            .expect("match succeeds");
        assert_eq!(result.matches.len(), 2, "expected two console.log matches");
        assert_eq!(result.files_with_matches, 1);
        assert_eq!(result.files_searched, 1);
        assert!(!result.limit_reached);
        for m in &result.matches {
            assert!(m.text.starts_with("console.log"));
            assert!(m.start_line >= 1);
            assert!(m.start_column >= 1);
        }
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn includes_meta_variables_when_requested() {
        let dir = fixture_dir();
        let file = write_fixture(&dir, "a.ts", "console.log('hi');\n");
        let result =
            ast_grep_inner("console.log($X)", &[file], &opts(true)).expect("match succeeds");
        assert_eq!(result.matches.len(), 1);
        let meta = result.matches[0]
            .meta_variables
            .as_ref()
            .expect("meta present");
        assert!(meta.contains_key("X"));
        assert_eq!(meta.get("X").map(String::as_str), Some("'hi'"));
    }

    #[test]
    fn skips_unsupported_extensions() {
        let dir = fixture_dir();
        let ts_file = write_fixture(&dir, "a.ts", "console.log(1);\n");
        let unknown = write_fixture(&dir, "b.unknownext", "console.log(1);\n");
        let result =
            ast_grep_inner("console.log($X)", &[unknown, ts_file], &opts(false)).expect("ok");
        assert_eq!(result.matches.len(), 1);
        assert_eq!(
            result.files_searched, 1,
            "unsupported extension must not count as searched"
        );
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn explicit_lang_overrides_extension() {
        let dir = fixture_dir();
        let file = write_fixture(&dir, "a.txt", "console.log(1);\n");
        let mut o = opts(false);
        o.lang = Some("typescript".to_string());
        let result = ast_grep_inner("console.log($X)", &[file], &o).expect("ok");
        assert_eq!(result.matches.len(), 1);
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn respects_match_limit() {
        let dir = fixture_dir();
        let file = write_fixture(&dir, "a.ts", "a(1); a(2); a(3); a(4); a(5);\n");
        let mut o = opts(false);
        o.limit = 2;
        let result = ast_grep_inner("a($X)", &[file], &o).expect("ok");
        assert_eq!(result.matches.len(), 2);
        assert!(
            result.limit_reached,
            "limit_reached must be true when truncated"
        );
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn rewrite_computes_changes_without_writing() {
        let dir = fixture_dir();
        let file = write_fixture(&dir, "a.ts", "console.log('hi');\n");
        let before = stdfs::read_to_string(&file).unwrap();
        let changes = ast_rewrite_inner(
            "console.log($X)",
            "console.error($X)",
            &[file.clone()],
            Some("typescript"),
            None,
            MatchStrictness::Smart,
            100,
        )
        .expect("rewrite computes");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].before, "console.log('hi')");
        assert_eq!(changes[0].after, "console.error('hi')");
        let after = stdfs::read_to_string(&file).unwrap();
        assert_eq!(before, after, "ast_rewrite must not write files");
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn alias_and_extension_resolution() {
        assert_eq!(alias_to_lang("TypeScript"), Some(SupportLang::TypeScript));
        assert_eq!(alias_to_lang("RUST"), Some(SupportLang::Rust));
        assert_eq!(
            extension_to_lang(Path::new("a.tsx")),
            Some(SupportLang::Tsx)
        );
        assert_eq!(extension_to_lang(Path::new("a.md")), None);
    }
}
