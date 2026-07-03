//! Glob-based path discovery exported over N-API, accelerating `glob` /
//! `find` / `repo.list`.
//!
//! Single entry point:
//!   - [`glob`] walks a caller-vetted root directory and returns the relative
//!     paths of files whose path matches a glob pattern.
//!
//! Path safety stays on the TypeScript side: the `glob` tool factory resolves
//! the base through the workspace guard (containment + symlink-escape
//! rejection) and hands the surviving absolute root to `glob`. The Rust side
//! only walks that exact root, so it cannot bypass the guard. A caller-supplied
//! denylist (the workspace `temp/ref-repos` / `node_modules` set) is applied
//! during the walk so large generated directories are never traversed.
//!
//! The walker is the `ignore` crate (the same crate ripgrep uses) configured
//! with gitignore/hidden/ignore all OFF to match the TypeScript fallback's raw
//! `readdir({ recursive: true })` behavior. Pattern matching uses `globset`
//! for standard glob syntax; patterns containing `{` / `}` fall back to a
//! regex replication of the TypeScript `globToRegExp` algorithm so brace
//! alternation does not diverge from the TS path.
//!
//! Brace sanitization and the glob-walker structure are adapted from
//! oh-my-pi's `crates/pi-natives/src/glob.rs` and `glob_util.rs` (MIT,
//! (c) 2025 Mario Zechner, 2025-2026 Can Boluk).
//!
//! No `unwrap` / `expect` / `panic`: every fallible op maps to a napi `Error`
//! (glob compile) or silently skips the offending entry (read / permission
//! errors), matching the crate-wide no-panic contract.

use std::path::Path;
use std::time::{Duration, Instant};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use regex::Regex;

/// Safety ceiling: a walk that exceeds this is abandoned and whatever was
/// collected so far is returned. Bounds pathological directory trees.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Options for [`glob`]. Field names are snake_case on the Rust side and
/// surface as camelCase over the N-API boundary.
#[napi(object)]
pub struct NativeGlobOptions {
    /// Maximum number of matching paths to return. Defaults to 100, matching
    /// the TypeScript `glob` tool `DEFAULT_MAX_RESULTS`.
    pub max_results: Option<u32>,
    /// Workspace denylist relative-path segments to skip during the walk
    /// (e.g. `["temp/ref-repos", "node_modules", ".git"]`). Applied before
    /// descent so large generated trees are never traversed.
    pub denylist: Option<Vec<String>>,
}

/// The matcher abstraction: globset for standard globs, regex for
/// brace-containing patterns that must replicate TypeScript `globToRegExp`
/// semantics (braces are literal there).
enum GlobMatcher {
    GlobSet(GlobSet),
    Regex(Regex),
}

impl GlobMatcher {
    fn is_match(&self, relative_path: &str) -> bool {
        match self {
            GlobMatcher::GlobSet(set) => set.is_match(relative_path),
            GlobMatcher::Regex(re) => re.is_match(relative_path),
        }
    }
}

/// Build a matcher from the pattern. Patterns containing `{` or `}` use a
/// regex replication of the TypeScript `globToRegExp` so brace alternation
/// (which globset supports but TS treats literally) cannot diverge.
fn build_matcher(pattern: &str) -> std::result::Result<GlobMatcher, String> {
    if pattern.contains('{') || pattern.contains('}') {
        let regex_str = glob_to_regex(pattern);
        let re = Regex::new(&regex_str).map_err(|err| format!("Invalid glob pattern: {err}"))?;
        return Ok(GlobMatcher::Regex(re));
    }
    let glob = GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|err| format!("Invalid glob pattern: {err}"))?;
    let set = GlobSetBuilder::new()
        .add(glob)
        .build()
        .map_err(|err| format!("Failed to build glob matcher: {err}"))?;
    Ok(GlobMatcher::GlobSet(set))
}

/// Replicate the TypeScript `globToRegExp` algorithm byte-for-byte so
/// brace-containing patterns produce identical match sets on both sides.
/// `*` -> `[^/]*`, `**` -> `.*` (consuming a following `/`), `?` -> `[^/]`,
/// regex-special chars escaped, anchored `^...$`.
fn glob_to_regex(pattern: &str) -> String {
    let mut regex = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        if char == '*' {
            if index + 1 < chars.len() && chars[index + 1] == '*' {
                regex.push_str(".*");
                index += 1;
                if index + 1 < chars.len() && chars[index + 1] == '/' {
                    index += 1;
                }
            } else {
                regex.push_str("[^/]*");
            }
        } else if char == '?' {
            regex.push_str("[^/]");
        } else if is_regex_special(char) {
            regex.push('\\');
            regex.push(char);
        } else {
            regex.push(char);
        }
        index += 1;
    }
    regex.push('$');
    regex
}

fn is_regex_special(char: char) -> bool {
    ".+()|{}[]^$\\".contains(char)
}

/// Check whether a workspace-relative path is denied by the denylist.
/// Replicates `matchesWorkspaceDenylist` from `read-tools-paths.ts`:
/// multi-segment entries are prefix matches; single-segment entries match any
/// path segment.
fn is_denied(relative_path: &str, denylist: &[String]) -> bool {
    for entry in denylist {
        let entry = entry.as_str();
        if entry.contains('/') {
            if relative_path == entry || relative_path.starts_with(&format!("{entry}/")) {
                return true;
            }
        } else if relative_path.split('/').any(|seg| seg == entry) {
            return true;
        }
    }
    false
}

/// Internal configuration for a single glob execution (plain Rust, no napi
/// types, so unit tests can exercise it without linking Node N-API symbols).
struct GlobConfig {
    max_results: usize,
    denylist: Vec<String>,
}

/// Pure glob core: walks `root`, matches relative paths against `pattern`,
/// and returns the sorted list of matching relative paths (using `/`
/// separators). Returns an error as a `String` for testability.
fn glob_inner(
    pattern: &str,
    root: &Path,
    config: &GlobConfig,
) -> std::result::Result<Vec<String>, String> {
    if config.max_results == 0 {
        return Ok(Vec::new());
    }
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let matcher = build_matcher(pattern)?;
    let root_buf = root.to_path_buf();
    let denylist_owned = config.denylist.clone();

    // Configure the walker to match the TS fallback's raw recursive readdir:
    // no gitignore, no hidden-skip, no symlink-follow. The denylist is
    // applied via filter_entry (on the builder, before build) so denied
    // directories are never descended into.
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .ignore(false)
        .parents(false)
        .follow_links(false);
    let walker = builder
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let rel = entry
                .path()
                .strip_prefix(&root_buf)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            !is_denied(&rel, &denylist_owned)
        })
        .build();

    let start = Instant::now();
    let mut matches: Vec<String> = Vec::new();
    for entry in walker {
        if start.elapsed() > TIMEOUT {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if relative.is_empty() {
            continue;
        }
        if matcher.is_match(&relative) {
            matches.push(relative);
            if matches.len() >= config.max_results {
                break;
            }
        }
    }
    matches.sort();
    Ok(matches)
}

/// Walk `root` and return the relative paths of files matching `pattern`,
/// capped at `opts.maxResults` (default 100). The denylist entries are
/// skipped during traversal. Returns paths with `/` separators, sorted
/// lexicographically.
#[napi]
pub fn glob(pattern: String, root: String, opts: NativeGlobOptions) -> Result<Vec<String>> {
    let config = GlobConfig {
        max_results: opts.max_results.map(|v| v as usize).unwrap_or(100),
        denylist: opts.denylist.unwrap_or_default(),
    };
    glob_inner(&pattern, Path::new(&root), &config).map_err(Error::from_reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static FIXTURE_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn fixture_dir() -> PathBuf {
        let seq = FIXTURE_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("mc-natives-glob-{}-{}", std::process::id(), seq));
        fs::create_dir_all(&dir).ok();
        dir
    }

    fn write_fixture_in(dir: &Path, name: &str, contents: &str) -> String {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(&path, contents).ok();
        path.to_string_lossy().to_string()
    }

    fn run_glob(pattern: &str, root: &Path, denylist: &[&str]) -> Vec<String> {
        glob_inner(
            pattern,
            root,
            &GlobConfig {
                max_results: 100,
                denylist: denylist.iter().map(|s| s.to_string()).collect(),
            },
        )
        .unwrap()
    }

    #[test]
    fn glob_to_regex_matches_typescript_semantics() {
        assert_eq!(glob_to_regex("*.ts"), "^[^/]*\\.ts$");
        assert_eq!(glob_to_regex("**/*.ts"), "^.*[^/]*\\.ts$");
        assert_eq!(glob_to_regex("src/*.json"), "^src/[^/]*\\.json$");
        assert_eq!(glob_to_regex("plain"), "^plain$");
        assert_eq!(glob_to_regex("{a,b}"), "^\\{a,b\\}$");
    }

    #[test]
    fn build_matcher_uses_regex_for_brace_patterns() {
        assert!(matches!(build_matcher("*.{ts,js}"), Ok(GlobMatcher::Regex(_))));
        assert!(matches!(build_matcher("*.ts"), Ok(GlobMatcher::GlobSet(_))));
    }

    #[test]
    fn glob_inner_returns_empty_for_empty_pattern() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "a.ts", "x");
        assert!(glob_inner("", &dir, &GlobConfig { max_results: 100, denylist: vec![] })
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_inner_matches_recursive_double_star() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "a.ts", "x");
        write_fixture_in(&dir, "src/b.ts", "x");
        write_fixture_in(&dir, "src/sub/c.ts", "x");
        write_fixture_in(&dir, "d.md", "x");
        let result = run_glob("**/*.ts", &dir, &[]);
        assert_eq!(result.len(), 3);
        assert!(result.contains(&"a.ts".to_string()));
        assert!(result.contains(&"src/b.ts".to_string()));
        assert!(result.contains(&"src/sub/c.ts".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_inner_single_star_matches_only_root_level() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "a.ts", "x");
        write_fixture_in(&dir, "src/b.ts", "x");
        let result = run_glob("*.ts", &dir, &[]);
        assert_eq!(result, vec!["a.ts".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_inner_respects_max_results() {
        let dir = fixture_dir();
        for i in 0..20 {
            write_fixture_in(&dir, &format!("f{:02}.ts", i), "x");
        }
        let result = glob_inner(
            "*.ts",
            &dir,
            &GlobConfig {
                max_results: 5,
                denylist: vec![],
            },
        )
        .unwrap();
        assert_eq!(result.len(), 5);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_inner_skips_denylisted_directories() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "src/a.ts", "x");
        write_fixture_in(&dir, "node_modules/pkg/index.ts", "x");
        write_fixture_in(&dir, "node_modules/pkg/deep/nested.ts", "x");
        let result = run_glob("**/*.ts", &dir, &["node_modules"]);
        assert_eq!(result, vec!["src/a.ts".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_inner_skips_multi_segment_denylist_entry() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "src/a.ts", "x");
        write_fixture_in(&dir, "temp/ref-repos/opencode/README.md", "ref");
        let result = run_glob("**/*", &dir, &["temp/ref-repos"]);
        assert!(result.iter().all(|p| !p.starts_with("temp/ref-repos")));
        assert!(result.contains(&"src/a.ts".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_inner_results_are_sorted() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "zebra.ts", "x");
        write_fixture_in(&dir, "alpha.ts", "x");
        write_fixture_in(&dir, "mango.ts", "x");
        let result = run_glob("*.ts", &dir, &[]);
        assert_eq!(result, vec!["alpha.ts", "mango.ts", "zebra.ts"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_inner_invalid_pattern_returns_error() {
        let dir = fixture_dir();
        let result = glob_inner("[", &dir, &GlobConfig { max_results: 100, denylist: vec![] });
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_denied_segment_match() {
        let denylist = vec!["node_modules".to_string()];
        assert!(is_denied("node_modules/pkg/index.ts", &denylist));
        assert!(is_denied("src/node_modules/foo.ts", &denylist));
        assert!(!is_denied("src/index.ts", &denylist));
    }

    #[test]
    fn is_denied_prefix_match() {
        let denylist = vec!["temp/ref-repos".to_string()];
        assert!(is_denied("temp/ref-repos", &denylist));
        assert!(is_denied("temp/ref-repos/opencode/README.md", &denylist));
        assert!(!is_denied("temp/other", &denylist));
    }

    #[test]
    fn build_matcher_rejects_truly_invalid_glob() {
        assert!(build_matcher("[invalid").is_err());
    }
}
