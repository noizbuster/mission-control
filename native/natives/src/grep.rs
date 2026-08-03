//! Regex content search exported over N-API, accelerating `repo.search` /
//! `grep` / `find`.
//!
//! Two entry points:
//!   - [`search`] runs a regex over a caller-vetted list of file paths and
//!     returns one row per matched line.
//!   - [`has_match`] short-circuits on the first matching file.
//!
//! Path safety stays on the TypeScript side: `repo.search` resolves the
//! target through the workspace guard (containment + `temp/ref-repos`
//! denylist) and hands the surviving absolute paths to `search`. The Rust
//! side only reads and matches those exact files, so it cannot bypass the
//! guard. This mirrors the existing `read-tools-search.ts` node fallback,
//! which the TypeScript wrapper falls back to when the addon is absent.
//!
//! The regex engine is `grep-regex` + `grep-searcher` (the same crates
//! ripgrep is built on). Brace sanitization and the literal-parenthesis
//! recovery are adapted from oh-my-pi's `crates/pi-natives/src/grep.rs`
//! (MIT, (c) 2025 Mario Zechner, 2025-2026 Can Boluk); the parallel file
//! iteration uses rayon instead of oh-my-pi's `ignore` directory walker
//! because the file set is already vetted by the time we get here.
//!
//! No `unwrap` / `expect` / `panic`: every fallible op maps to a napi
//! `Error` (regex compile) or silently skips the offending file (read /
//! permission errors), matching the crate-wide no-panic contract.

use std::borrow::Cow;
use std::io;
use std::path::Path;
use std::sync::Arc;

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use rayon::prelude::*;

use crate::fs_cache;

/// Files above this size are skipped, bounding memory on monorepos with
/// generated/minified blobs. Matches oh-my-pi's ceiling.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Options for [`search`]. Field names are snake_case on the Rust side and
/// surface as camelCase over the N-API boundary (napi-derive convention).
#[napi(object)]
pub struct GrepOptions {
    /// Glob include filter such as `*.ts`. Applied as a suffix match that
    /// mirrors the TypeScript `repo.search` node fallback (`endsWith` after
    /// stripping a leading `*`) so the two paths stay output-identical.
    pub include: Option<String>,
    /// Output mode: `"content"` (default), `"files_with_matches"`, or
    /// `"count"`. The `repo.search` wiring always uses `"content"`.
    pub output_mode: Option<String>,
    /// Optional safety cap on the number of collected matches. The TypeScript
    /// caller leaves this unset and slices on its own `maxSearchMatches`, so
    /// the full match set is returned (matching the existing ripgrep path).
    pub head_limit: Option<u32>,
    /// Reserved for API symmetry with the reference implementation. The
    /// mission-control caller pre-vets paths, so `.gitignore` is not consulted
    /// here. Kept on the struct so the N-API shape stays stable.
    pub gitignore: Option<bool>,
}

/// A single matched line. Paths are returned exactly as received (absolute
/// when the caller passes absolute paths); the TypeScript wrapper converts
/// them to workspace-relative form.
#[napi(object)]
pub struct GrepMatch {
    /// File path, verbatim from the input list.
    pub path: String,
    /// 1-indexed line number of the match.
    pub line_number: u32,
    /// Matched line content with its trailing line ending trimmed.
    pub line_content: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    Content,
    FilesWithMatches,
    Count,
}

fn parse_output_mode(mode: Option<&str>) -> OutputMode {
    match mode {
        Some("files_with_matches") => OutputMode::FilesWithMatches,
        Some("count") => OutputMode::Count,
        _ => OutputMode::Content,
    }
}

/// Strip a single trailing `\n` / `\r\n` from matched-line bytes. grep-searcher
/// includes the terminator in `SinkMatch::bytes`; the TypeScript paths trim it
/// too (`text.replace(/\n$/, '')` for ripgrep, `split(/\r?\n/)` for the node
/// fallback), so trimming here keeps the line text identical.
fn trim_line(bytes: &[u8]) -> String {
    let mut end = bytes.len();
    if end > 0 && bytes[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && bytes[end - 1] == b'\r' {
        end -= 1;
    }
    match std::str::from_utf8(&bytes[..end]) {
        Ok(text) => text.to_string(),
        Err(_) => String::from_utf8_lossy(&bytes[..end]).into_owned(),
    }
}

/// Collect matched lines (1-indexed line number + trimmed text) and a full
/// match count. The count keeps incrementing past any `limit` so callers can
/// report `totalMatches` even when only a slice is retained.
struct LineCollector {
    matches: Vec<(u64, String)>,
    count: u64,
    limit: Option<u64>,
}

impl LineCollector {
    fn new(limit: Option<u64>) -> Self {
        Self {
            matches: Vec::new(),
            count: 0,
            limit,
        }
    }
}

impl Sink for LineCollector {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch) -> io::Result<bool> {
        self.count += 1;
        let under_limit = match self.limit {
            Some(limit) => (self.matches.len() as u64) < limit,
            None => true,
        };
        if under_limit {
            let line_number = mat.line_number().unwrap_or(0);
            self.matches.push((line_number, trim_line(mat.bytes())));
        }
        Ok(true)
    }
}

fn build_searcher() -> Searcher {
    SearcherBuilder::new()
        // Quit on the first NUL byte so binary files produce no matches,
        // matching the TypeScript `isBinarySample` NUL-byte signal.
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build()
}

// ---------------------------------------------------------------------------
// Regex brace / parenthesis sanitization (adapted from oh-my-pi, MIT)
// ---------------------------------------------------------------------------

/// Check whether `bytes[start]` (a `b'{'`) begins a valid repetition
/// quantifier (`{N}`, `{N,}`, `{N,M}`). Returns the index of the closing `}`.
fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
    let len = bytes.len();
    let mut i = start + 1;
    if i >= len || !bytes[i].is_ascii_digit() {
        return None;
    }
    while i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i >= len {
        return None;
    }
    if bytes[i] == b'}' {
        return Some(i);
    }
    if bytes[i] != b',' {
        return None;
    }
    i += 1;
    if i >= len {
        return None;
    }
    while i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i < len && bytes[i] == b'}' {
        Some(i)
    } else {
        None
    }
}

/// Escape `{` / `}` that do not form valid repetition quantifiers. Patterns
/// like `${platform}` contain braces the regex engine rejects as malformed
/// repetitions; escaping them is semantics-preserving and avoids confusing
/// errors for callers passing literal text fragments.
fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
    let bytes = pattern.as_bytes();
    if !bytes.contains(&b'{') && !bytes.contains(&b'}') {
        return Cow::Borrowed(pattern);
    }
    let len = bytes.len();
    let mut result = String::with_capacity(len + 8);
    let mut modified = false;
    let mut i = 0;
    while i < len {
        if bytes[i] == b'\\' && i + 1 < len {
            result.push('\\');
            i += 1;
            let ch = match pattern[i..].chars().next() {
                Some(ch) => ch,
                None => break,
            };
            result.push(ch);
            i += ch.len_utf8();
            continue;
        }
        if bytes[i] == b'{' {
            if let Some(end) = find_valid_repetition(bytes, i) {
                result.push_str(&pattern[i..=end]);
                i = end + 1;
                continue;
            }
            result.push_str("\\{");
            i += 1;
            modified = true;
            continue;
        }
        if bytes[i] == b'}' {
            result.push_str("\\}");
            i += 1;
            modified = true;
            continue;
        }
        let ch = match pattern[i..].chars().next() {
            Some(ch) => ch,
            None => break,
        };
        result.push(ch);
        i += ch.len_utf8();
    }
    if modified {
        Cow::Owned(result)
    } else {
        Cow::Borrowed(pattern)
    }
}

/// Escape unescaped parentheses, used to recover after a group-syntax error so
/// literal snippets such as `fetchAnthropicProvider(` still search usefully.
fn escape_unescaped_parentheses(pattern: &str) -> Cow<'_, str> {
    let bytes = pattern.as_bytes();
    if !bytes.contains(&b'(') && !bytes.contains(&b')') {
        return Cow::Borrowed(pattern);
    }
    let mut result = String::with_capacity(pattern.len() + 4);
    let mut modified = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            result.push('\\');
            i += 1;
            let ch = match pattern[i..].chars().next() {
                Some(ch) => ch,
                None => break,
            };
            result.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let ch = match pattern[i..].chars().next() {
            Some(ch) => ch,
            None => break,
        };
        if ch == '(' || ch == ')' {
            result.push('\\');
            modified = true;
        }
        result.push(ch);
        i += ch.len_utf8();
    }
    if modified {
        Cow::Owned(result)
    } else {
        Cow::Borrowed(pattern)
    }
}

fn build_regex(pattern: &str) -> std::result::Result<grep_regex::RegexMatcher, grep_regex::Error> {
    RegexMatcherBuilder::new().build(pattern)
}

/// Build a matcher, sanitizing braces first and escaping stray parentheses on
/// a group-syntax retry. Pure layer: returns the regex error as a `String` so
/// unit tests can exercise it without instantiating `napi::Error` (whose Drop
/// pulls Node N-API symbols that a `cargo test` binary cannot link). The
/// `#[napi]` entry points convert this `String` into a napi `Error`.
fn build_matcher_inner(pattern: &str) -> std::result::Result<grep_regex::RegexMatcher, String> {
    let sanitized = sanitize_braces(pattern);
    match build_regex(sanitized.as_ref()) {
        Ok(matcher) => Ok(matcher),
        Err(err) => {
            let message = err.to_string();
            if message.contains("unclosed group") || message.contains("unopened group") {
                let escaped = escape_unescaped_parentheses(sanitized.as_ref());
                if escaped.as_ref() != sanitized.as_ref() {
                    return build_regex(escaped.as_ref())
                        .map_err(|retry| format!("Regex error: {retry}"));
                }
            }
            Err(format!("Regex error: {message}"))
        }
    }
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

enum ReadFile {
    Bytes(Arc<Vec<u8>>),
    Oversized,
    Skipped,
}

/// Read a file's bytes through the shared mtime-keyed cache
/// (`fs_cache::read_file_bytes_cached`). On a cache hit the bytes come from
/// the cache without a `read_to_end`; on a miss they are read fresh and
/// cached. A mutated file has a different mtime and therefore misses, so grep
/// never searches stale content. `Oversized`/`Skipped` bypass the cache and
/// behave exactly like the uncached path.
fn read_file_bytes(path: &Path) -> ReadFile {
    match fs_cache::read_file_bytes_cached(path, MAX_FILE_BYTES) {
        fs_cache::CachedRead::Hit(bytes) | fs_cache::CachedRead::Miss(bytes) => {
            ReadFile::Bytes(bytes)
        }
        fs_cache::CachedRead::Oversized => ReadFile::Oversized,
        fs_cache::CachedRead::Skipped => ReadFile::Skipped,
    }
}

// ---------------------------------------------------------------------------
// Include filter (mirrors the TypeScript node-fallback suffix match)
// ---------------------------------------------------------------------------

/// Reproduce `input.include.replace(/^\*/, '')` + `endsWith`: strip a single
/// leading `*`, then accept paths whose string form ends with the remainder.
fn include_allows(include: Option<&str>, path_str: &str) -> bool {
    let Some(include) = include else { return true };
    let trimmed = include.strip_prefix('*').unwrap_or(include);
    if trimmed.is_empty() {
        return true;
    }
    path_str.ends_with(trimmed)
}

// ---------------------------------------------------------------------------
// N-API entry points
// ---------------------------------------------------------------------------

/// Outcome of searching a single file, before flattening into [`GrepMatch`].
struct FileOutcome {
    path: String,
    /// `(line_number, line_text)` for every match (content mode).
    matches: Vec<(u64, String)>,
    /// True total match count for this file (>= `matches.len()` when a head
    /// limit truncated the retained set).
    match_count: u64,
}

/// `(path, line_number, line_text)` rows plus the overall match count.
type SearchRows = (Vec<(String, u64, String)>, u64);

/// Pure search core: returns `(path, line_number, line_text)` tuples plus a
/// total count. Kept free of napi types so unit tests can exercise it without
/// linking Node N-API symbols (see [`build_matcher_inner`]).
fn search_inner(
    pattern: &str,
    paths: &[String],
    include: Option<&str>,
    mode: OutputMode,
    head_limit: Option<u64>,
) -> std::result::Result<SearchRows, String> {
    if paths.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let matcher = build_matcher_inner(pattern)?;
    let outcomes: Vec<FileOutcome> = paths
        .par_iter()
        .filter_map(|path_str| {
            if !include_allows(include, path_str) {
                return None;
            }
            let path = Path::new(path_str);
            let bytes = match read_file_bytes(path) {
                ReadFile::Bytes(bytes) => bytes,
                ReadFile::Oversized | ReadFile::Skipped => return None,
            };
            search_file(&matcher, path_str, &bytes[..], mode, head_limit)
        })
        .collect();
    Ok(aggregate_inner(outcomes, mode))
}

/// Pure existence check. Short-circuits in parallel via rayon's `any`.
fn has_match_inner(pattern: &str, paths: &[String]) -> std::result::Result<bool, String> {
    if paths.is_empty() {
        return Ok(false);
    }
    let matcher = build_matcher_inner(pattern)?;
    let hit = paths
        .par_iter()
        .any(|path_str| match read_file_bytes(Path::new(path_str)) {
            ReadFile::Bytes(bytes) => matcher.is_match(&bytes[..]).unwrap_or(false),
            ReadFile::Oversized | ReadFile::Skipped => false,
        });
    Ok(hit)
}

/// Search `paths` for `pattern` and return one [`GrepMatch`] per matched line
/// (content mode), one per matching file (`files_with_matches`), or one count
/// row per file (`count`). Files are read in parallel; read/permission errors
/// skip the offending file rather than failing the whole call.
#[napi]
pub fn search(pattern: String, paths: Vec<String>, opts: GrepOptions) -> Result<Vec<GrepMatch>> {
    let mode = parse_output_mode(opts.output_mode.as_deref());
    let head_limit = opts.head_limit.map(u64::from);
    let (rows, _total) = search_inner(&pattern, &paths, opts.include.as_deref(), mode, head_limit)
        .map_err(Error::from_reason)?;
    Ok(rows
        .into_iter()
        .map(|(path, line_number, line_content)| GrepMatch {
            path,
            line_number: clamp_u32(line_number),
            line_content,
        })
        .collect())
}

/// Return `true` as soon as any file in `paths` contains a match for
/// `pattern`. Short-circuits in parallel via rayon's `any`.
#[napi]
pub fn has_match(pattern: String, paths: Vec<String>) -> Result<bool> {
    has_match_inner(&pattern, &paths).map_err(Error::from_reason)
}

fn search_file(
    matcher: &grep_regex::RegexMatcher,
    path_str: &str,
    bytes: &[u8],
    mode: OutputMode,
    limit: Option<u64>,
) -> Option<FileOutcome> {
    match mode {
        OutputMode::Content => {
            let mut searcher = build_searcher();
            let mut collector = LineCollector::new(limit);
            if searcher
                .search_slice(matcher, bytes, &mut collector)
                .is_err()
            {
                return None;
            }
            if collector.count == 0 {
                return None;
            }
            Some(FileOutcome {
                path: path_str.to_string(),
                matches: collector.matches,
                match_count: collector.count,
            })
        }
        OutputMode::FilesWithMatches | OutputMode::Count => {
            if mode == OutputMode::FilesWithMatches {
                let matched = matcher.is_match(bytes).unwrap_or(false);
                return matched.then(|| FileOutcome {
                    path: path_str.to_string(),
                    matches: Vec::new(),
                    match_count: 1,
                });
            }
            let mut searcher = build_searcher();
            let mut collector = LineCollector::new(None);
            if searcher
                .search_slice(matcher, bytes, &mut collector)
                .is_err()
            {
                return None;
            }
            if collector.count == 0 {
                return None;
            }
            Some(FileOutcome {
                path: path_str.to_string(),
                matches: Vec::new(),
                match_count: collector.count,
            })
        }
    }
}

/// Flatten per-file outcomes into a single sorted `(path, line, text)` list
/// plus the overall match count. Sort is by `(path, line_number)`; the
/// TypeScript wrapper re-sorts with its own `compareMatches` for exact
/// locale-aware parity.
fn aggregate_inner(outcomes: Vec<FileOutcome>, mode: OutputMode) -> SearchRows {
    let mut rows: Vec<(String, u64, String)> = Vec::new();
    let mut total = 0u64;
    match mode {
        OutputMode::Content => {
            for outcome in outcomes {
                total = total.saturating_add(outcome.match_count);
                for (line_number, line_content) in outcome.matches {
                    rows.push((outcome.path.clone(), line_number, line_content));
                }
            }
            rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        }
        OutputMode::FilesWithMatches | OutputMode::Count => {
            for outcome in outcomes {
                total = total.saturating_add(outcome.match_count);
                rows.push((outcome.path, 0, outcome.match_count.to_string()));
            }
            rows.sort_by(|a, b| a.0.cmp(&b.0));
        }
    }
    (rows, total)
}

fn clamp_u32(value: u64) -> u32 {
    if value > u32::MAX as u64 {
        u32::MAX
    } else {
        value as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static FIXTURE_SEQ: AtomicUsize = AtomicUsize::new(0);

    // Each test gets its own subdirectory so parallel tests do not clobber
    // each other's fixtures.
    fn fixture_dir() -> PathBuf {
        let seq = FIXTURE_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("mc-natives-grep-{}-{}", std::process::id(), seq));
        fs::create_dir_all(&dir).ok();
        dir
    }

    fn write_fixture_in(dir: &Path, name: &str, contents: &str) -> String {
        let path = dir.join(name);
        fs::write(&path, contents).ok();
        path.to_string_lossy().to_string()
    }

    fn run_search(pattern: &str, paths: &[String]) -> SearchRows {
        search_inner(pattern, paths, None, OutputMode::Content, None).unwrap()
    }

    #[test]
    fn sanitize_braces_escapes_invalid_repetition() {
        // `${platform}` has no valid repetition, so braces are escaped to `\{`
        // / `\}` while the leading `$` passes through untouched.
        assert_eq!(sanitize_braces("${platform}"), "$\\{platform\\}");
        assert_eq!(sanitize_braces("a{2,3}"), "a{2,3}");
        assert_eq!(sanitize_braces("plain"), "plain");
    }

    #[test]
    fn build_matcher_inner_recovers_literal_parenthesis() {
        assert!(build_matcher_inner("fetchAnthropicProvider(").is_ok());
    }

    #[test]
    fn build_matcher_inner_rejects_truly_invalid_regex() {
        assert!(build_matcher_inner("(*").is_err());
    }

    #[test]
    fn search_inner_returns_empty_for_empty_paths() {
        let (rows, total) = search_inner("x", &[], None, OutputMode::Content, None).unwrap();
        assert!(rows.is_empty());
        assert_eq!(total, 0);
    }

    #[test]
    fn search_inner_collects_matches_with_line_numbers() {
        let dir = fixture_dir();
        let a = write_fixture_in(&dir, "a.txt", "alpha\nbeta\nalpha\n");
        let b = write_fixture_in(&dir, "b.md", "alpha only\n");
        let mut paths = vec![b.clone(), a.clone()];
        paths.sort();
        let (rows, total) = run_search("alpha", &paths);
        assert_eq!(total, 3);
        assert_eq!(rows.len(), 3);
        // Sorted by (path, line): a.txt precedes b.md.
        assert_eq!(rows[0].0, a);
        assert_eq!(rows[0].1, 1);
        assert_eq!(rows[0].2, "alpha");
        assert_eq!(rows[1].1, 3);
        assert_eq!(rows[2].0, b);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_inner_respects_include_suffix_filter() {
        let dir = fixture_dir();
        let ts_file = write_fixture_in(&dir, "mod.ts", "needle\n");
        let md_file = write_fixture_in(&dir, "mod.md", "needle\n");
        let paths = vec![md_file, ts_file.clone()];
        let (rows, _) =
            search_inner("needle", &paths, Some("*.ts"), OutputMode::Content, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].0.ends_with("mod.ts"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_inner_skips_oversized_and_binary_files() {
        let dir = fixture_dir();
        let big = write_fixture_in(&dir, "big.txt", &"a".repeat((MAX_FILE_BYTES + 1) as usize));
        let bin = write_fixture_in(&dir, "bin.dat", "needle\x00rest\n");
        let (rows, _) = run_search("needle", &[big, bin]);
        assert!(
            rows.is_empty(),
            "oversized and binary files must be skipped"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_inner_parallel_is_deterministic() {
        let dir = fixture_dir();
        let mut paths = Vec::new();
        for i in 0..40 {
            paths.push(write_fixture_in(
                &dir,
                &format!("f{:03}.txt", i),
                &format!("hit line {}\n", i),
            ));
        }
        paths.sort();
        let (rows, total) = run_search("hit", &paths);
        assert_eq!(total, 40);
        assert_eq!(rows.len(), 40);
        let mut prev = "";
        for (path, line, _text) in &rows {
            assert!(path.as_str() >= prev, "rows must be sorted by path");
            assert_eq!(*line, 1);
            prev = path;
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_inner_count_mode_reports_per_file_totals() {
        let dir = fixture_dir();
        let a = write_fixture_in(&dir, "a.txt", "x\nx\nx\n");
        let b = write_fixture_in(&dir, "b.txt", "x\n");
        let mut paths = vec![a.clone(), b.clone()];
        paths.sort();
        let (rows, total) = search_inner("x", &paths, None, OutputMode::Count, None).unwrap();
        assert_eq!(total, 4);
        assert_eq!(rows.len(), 2);
        // a.txt precedes b.txt after the sort; 3 then 1 matches.
        assert_eq!(rows[0].0, a);
        assert_eq!(rows[0].2, "3");
        assert_eq!(rows[1].0, b);
        assert_eq!(rows[1].2, "1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn has_match_inner_short_circuits() {
        let dir = fixture_dir();
        let yes = write_fixture_in(&dir, "yes.txt", "target found\n");
        let no = write_fixture_in(&dir, "no.txt", "nothing here\n");
        assert!(has_match_inner("target", &[yes.clone()]).unwrap());
        assert!(!has_match_inner("target", &[no.clone()]).unwrap());
        assert!(has_match_inner("target", &[no, yes]).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn include_allows_mirrors_node_suffix_match() {
        assert!(include_allows(None, "any/file.ts"));
        assert!(include_allows(Some("*.ts"), "src/mod.ts"));
        assert!(!include_allows(Some("*.ts"), "src/mod.md"));
        assert!(include_allows(Some("*"), "src/mod.md"));
    }
}
