//! Fuzzy file-path discovery exported over N-API, accelerating `find` /
//! autocomplete-style path lookup.
//!
//! Entry point:
//!   - [`fuzzy_find`] walks a caller-vetted root and returns relative paths
//!     whose basename or full path fuzzy-matches a query string, sorted by
//!     match quality.
//!
//! Path safety mirrors [`crate::glob`]: the TypeScript caller resolves the
//! root through the workspace guard and passes the surviving absolute path.
//! The denylist is applied during traversal so generated trees are skipped.
//!
//! The subsequence scoring algorithm is adapted from oh-my-pi's
//! `crates/pi-natives/src/fd.rs` (MIT, (c) 2025 Mario Zechner, 2025-2026
//! Can Boluk): exact/prefix/contains basename matches rank highest, then
//! fuzzy subsequence matches on the basename, then path-level matches.
//!
//! No `unwrap` / `expect` / `panic`.

use std::path::Path;
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;

const TIMEOUT: Duration = Duration::from_secs(60);

#[napi(object)]
pub struct NativeFuzzyFindOptions {
    pub max_results: Option<u32>,
    pub denylist: Option<Vec<String>>,
}

struct FuzzyConfig {
    max_results: usize,
    denylist: Vec<String>,
}

struct ScoredMatch {
    path: String,
    score: u32,
}

fn normalize_fuzzy_text(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn fuzzy_subsequence_score(query_chars: &[char], target: &str) -> u32 {
    if query_chars.is_empty() {
        return 1;
    }
    let mut query_index = 0usize;
    let mut gaps = 0u32;
    let mut last_match_index: Option<usize> = None;
    for (target_index, target_ch) in target.chars().enumerate() {
        if query_index >= query_chars.len() {
            break;
        }
        if query_chars[query_index] == target_ch {
            if let Some(last_index) = last_match_index {
                if target_index > last_index + 1 {
                    gaps = gaps.saturating_add(1);
                }
            }
            last_match_index = Some(target_index);
            query_index += 1;
        }
    }
    if query_index != query_chars.len() {
        return 0;
    }
    let gap_penalty = gaps.saturating_mul(5);
    40u32.saturating_sub(gap_penalty).max(1)
}

fn score_fuzzy_path(
    path: &str,
    query_lower: &str,
    normalized_query: &str,
    query_chars: &[char],
) -> u32 {
    if query_lower.is_empty() {
        return 1;
    }
    let query_has_slash = query_lower.contains('/');
    let file_name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path);
    let lower_file_name = file_name.to_lowercase();

    if lower_file_name == query_lower {
        120
    } else if lower_file_name.starts_with(query_lower) {
        100
    } else if lower_file_name.contains(query_lower) {
        80
    } else if !query_has_slash {
        let normalized_file_name = normalize_fuzzy_text(file_name);
        let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
        if file_name_fuzzy > 0 {
            50 + file_name_fuzzy
        } else {
            0
        }
    } else {
        let lower_path = path.to_lowercase();
        if lower_path.contains(query_lower) {
            60
        } else {
            let normalized_file_name = normalize_fuzzy_text(file_name);
            let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
            if file_name_fuzzy > 0 {
                50 + file_name_fuzzy
            } else {
                let normalized_path = normalize_fuzzy_text(path);
                let path_fuzzy = if normalized_path == normalized_query {
                    40
                } else {
                    fuzzy_subsequence_score(query_chars, &normalized_path)
                };
                if path_fuzzy > 0 {
                    30 + path_fuzzy
                } else {
                    0
                }
            }
        }
    }
}

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

fn fuzzy_find_inner(
    query: &str,
    root: &Path,
    config: &FuzzyConfig,
) -> std::result::Result<Vec<String>, String> {
    if config.max_results == 0 {
        return Ok(Vec::new());
    }
    let query_lower = query.trim().to_lowercase();
    let normalized_query = normalize_fuzzy_text(&query_lower);
    let query_chars: Vec<char> = normalized_query.chars().collect();
    if !query_lower.is_empty() && normalized_query.is_empty() {
        return Ok(Vec::new());
    }

    let root_buf = root.to_path_buf();
    let denylist_owned = config.denylist.clone();
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
    let mut scored: Vec<ScoredMatch> = Vec::new();
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
        let score = score_fuzzy_path(&relative, &query_lower, &normalized_query, &query_chars);
        if score > 0 {
            scored.push(ScoredMatch { path: relative, score });
        }
    }
    scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    let matches: Vec<String> = scored.into_iter().take(config.max_results).map(|m| m.path).collect();
    Ok(matches)
}

#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find(query: String, root: String, opts: NativeFuzzyFindOptions) -> Result<Vec<String>> {
    let config = FuzzyConfig {
        max_results: opts.max_results.map(|v| v as usize).unwrap_or(100),
        denylist: opts.denylist.unwrap_or_default(),
    };
    fuzzy_find_inner(&query, Path::new(&root), &config).map_err(Error::from_reason)
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
        let dir = std::env::temp_dir().join(format!("mc-natives-fd-{}-{}", std::process::id(), seq));
        fs::create_dir_all(&dir).ok();
        dir
    }

    fn write_fixture_in(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(&path, "x").ok();
        path.to_string_lossy().to_string()
    }

    fn run_fuzzy(query: &str, root: &Path, denylist: &[&str]) -> Vec<String> {
        fuzzy_find_inner(
            query,
            root,
            &FuzzyConfig {
                max_results: 100,
                denylist: denylist.iter().map(|s| s.to_string()).collect(),
            },
        )
        .unwrap()
    }

    #[test]
    fn fuzzy_subsequence_scores_gaps() {
        let chars: Vec<char> = "abc".chars().collect();
        assert_eq!(fuzzy_subsequence_score(&chars, "abc"), 40);
        assert!(fuzzy_subsequence_score(&chars, "axbxc") < 40);
        assert_eq!(fuzzy_subsequence_score(&chars, "xyz"), 0);
    }

    #[test]
    fn fuzzy_find_ranks_exact_basename_first() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "glob.rs");
        write_fixture_in(&dir, "src/globby.ts");
        write_fixture_in(&dir, "tokens.rs");
        let result = run_fuzzy("glob", &dir, &[]);
        assert_eq!(result.first(), Some(&"glob.rs".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fuzzy_find_respects_max_results() {
        let dir = fixture_dir();
        for i in 0..20 {
            write_fixture_in(&dir, &format!("test{:02}.ts", i));
        }
        let result = fuzzy_find_inner(
            "test",
            &dir,
            &FuzzyConfig { max_results: 5, denylist: vec![] },
        )
        .unwrap();
        assert_eq!(result.len(), 5);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fuzzy_find_skips_denylisted_dirs() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "src/app.ts");
        write_fixture_in(&dir, "node_modules/pkg/app.js");
        let result = run_fuzzy("app", &dir, &["node_modules"]);
        assert_eq!(result, vec!["src/app.ts".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fuzzy_find_empty_query_returns_some_results() {
        let dir = fixture_dir();
        write_fixture_in(&dir, "a.ts");
        let result = run_fuzzy("", &dir, &[]);
        assert!(!result.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_strips_separators_and_punctuation() {
        assert_eq!(normalize_fuzzy_text("foo-bar_baz.ts"), "foobarbazts");
        assert_eq!(normalize_fuzzy_text("A/B"), "ab");
    }
}
