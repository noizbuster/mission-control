//! Shared mtime-keyed file-content cache, exported over N-API and consumed
//! transparently by the read-heavy tools (`grep` today; `glob`/`summary`
//! defer to it once they read content themselves).
//!
//! Design (adapted from oh-my-pi's `crates/pi-natives/src/fs_cache.rs`,
//! MIT, (c) 2025 Mario Zechner, 2025-2026 Can Boluk — but oh-my-pi caches
//! directory *scan entries* under a TTL; this crate caches file *content*
//! under an mtime key, the shape task 9 of the port-ref-tools plan calls
//! for):
//!
//! - Process-global `DashMap<(PathBuf, SystemTime), Arc<Vec<u8>>>`. The key
//!   is `(resolved absolute path, mtime)`; the value is the file bytes. A
//!   stale mtime (file mutated) is a clean cache miss, which is the
//!   TOCTOU guard: the consumer reads the *current* mtime from the freshly
//!   opened file and only a key whose mtime still matches can hit.
//! - The only mutation the cache ever sees, besides insert/evict, is a
//!   wholesale clear from [`invalidate_fs_scan_cache`], wired to the
//!   workspace file-mutation queue so a successful `file.edit`/`write`/
//!   `patch` always bumps the cache and the next read is fresh.
//! - The cache is an OPTIONAL acceleration: every consumer still works
//!   when the cache is empty, disabled, or absent. Output contracts are
//!   untouched.
//!
//! Path keying uses the resolved absolute path (canonicalized for relative
//! or symlinked input; passed through for already-absolute input so the
//! hot path stays a single `open`+`metadata`). This gives iso-worktree
//! divergence for free once task 18 lands: two worktrees with the same
//! relative path resolve to different absolute keys.
//!
//! No `unwrap` / `expect` / `panic`: every fallible op degrades to a cache
//! miss (and a fresh read) rather than aborting, matching the crate-wide
//! no-panic contract.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::SystemTime;

use dashmap::DashMap;
use napi_derive::napi;

/// Soft cap on the number of cached files. When an insert would exceed it
/// the whole map is cleared (coarse but safe: file mutations already clear
/// the map wholesale, and the cache is repopulated on the next read). The
/// bound protects memory on monorepos with many distinct files.
const MAX_CACHE_ENTRIES: usize = 256;

type CacheKey = (PathBuf, SystemTime);

/// The mtime-keyed file-content cache. Held as a process-global singleton
/// ([`GLOBAL_FS_CACHE`]) for the `#[napi]` export and the grep read path; the
/// Rust unit tests construct their own `FsCache::new()` so parallel tests get
/// fully isolated maps (a shared global under `cargo test`'s parallel threads
/// made invalidate/insert sequences racy).
pub(crate) struct FsCache {
    map: DashMap<CacheKey, Arc<Vec<u8>>>,
}

impl FsCache {
    pub(crate) fn new() -> Self {
        Self {
            map: DashMap::new(),
        }
    }

    /// Lookup cached content for `(resolved path, mtime)`. `None` means a
    /// miss or a stale mtime — the caller must read fresh.
    pub(crate) fn get(&self, path: &Path, mtime: SystemTime) -> Option<Arc<Vec<u8>>> {
        let key_path = resolve_key_path(path);
        self.map
            .get(&(key_path, mtime))
            .map(|entry| Arc::clone(entry.value()))
    }

    /// Store `content` under `(resolved path, mtime)`. Enforces the soft
    /// entry cap by clearing the whole map on overflow before inserting.
    pub(crate) fn put(&self, path: &Path, mtime: SystemTime, content: Arc<Vec<u8>>) {
        if self.map.len() >= MAX_CACHE_ENTRIES {
            self.map.clear();
        }
        self.map.insert((resolve_key_path(path), mtime), content);
    }

    /// Drop every cached entry.
    pub(crate) fn invalidate_all(&self) {
        self.map.clear();
    }

    /// Number of entries currently cached (tests/benches only).
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }

    /// Read `path`'s bytes through this cache. Opens the file once, reads its
    /// `metadata` for the mtime + size + file-type check, and either returns
    /// the cached bytes for the current mtime or reads-and-caches the content.
    /// Oversized / missing / no-mtime files bypass the cache.
    pub(crate) fn read_file_bytes_cached(&self, path: &Path, max_bytes: u64) -> CachedRead {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(_) => return CachedRead::Skipped,
        };
        let metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(_) => return CachedRead::Skipped,
        };
        if !metadata.is_file() {
            return CachedRead::Skipped;
        }
        if metadata.len() > max_bytes {
            return CachedRead::Oversized;
        }
        // An FS that cannot report an mtime cannot key the cache; read fresh
        // and skip caching so the caller still gets correct (uncached) content.
        let mtime = match metadata.modified() {
            Ok(mtime) => mtime,
            Err(_) => return read_fresh_uncached(file),
        };
        if let Some(cached) = self.get(path, mtime) {
            return CachedRead::Hit(cached);
        }
        let bytes = match read_to_vec(file) {
            Ok(bytes) => bytes,
            Err(_) => return CachedRead::Skipped,
        };
        let shared = Arc::new(bytes);
        self.put(path, mtime, Arc::clone(&shared));
        CachedRead::Miss(shared)
    }
}

impl Default for FsCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Process-global cache backing the `#[napi]` export and the grep read path.
static GLOBAL_FS_CACHE: LazyLock<FsCache> = LazyLock::new(FsCache::new);

/// Resolve `path` to the cache key's path component. Already-absolute paths
/// (the common case — the TypeScript callers hand absolute paths in) are
/// used verbatim so the hot path avoids an extra `canonicalize` syscall per
/// read. Relative or symlink-bearing paths are canonicalized so two spellings
/// of the same file share one entry. `canonicalize` failure falls back to the
/// path as given; the worst case is a cache miss (fresh read), never stale
/// content.
fn resolve_key_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

// --- Free-function wrappers over the global singleton ---------------------
// These keep the napi export and the grep read path on their existing call
// sites while the Rust tests exercise isolated `FsCache` instances directly.

/// Drop every cached entry from the global cache. Called by
/// [`invalidate_fs_scan_cache`].
pub(crate) fn invalidate_all_inner() {
    GLOBAL_FS_CACHE.invalidate_all();
}

/// Read `path`'s bytes through the global cache (grep's read path).
pub(crate) fn read_file_bytes_cached(path: &Path, max_bytes: u64) -> CachedRead {
    GLOBAL_FS_CACHE.read_file_bytes_cached(path, max_bytes)
}

/// Outcome of a cached file read, mirroring the existing uncached
/// `ReadFile` shape plus a flag distinguishing a cache hit from a fresh read
/// so tests/benches can observe the cache.
#[derive(Debug)]
pub(crate) enum CachedRead {
    /// File bytes, served from the cache (no `read_to_end`).
    Hit(Arc<Vec<u8>>),
    /// File bytes, freshly read from disk (and now cached).
    Miss(Arc<Vec<u8>>),
    /// File exceeded `max_bytes`; not cached.
    Oversized,
    /// File could not be opened / read / stat'd; not cached.
    Skipped,
}

impl CachedRead {
    /// Returns the bytes for a `Hit`/`Miss`, `None` for `Oversized`/`Skipped`.
    #[cfg(test)]
    pub(crate) fn bytes(self) -> Option<Arc<Vec<u8>>> {
        match self {
            CachedRead::Hit(bytes) | CachedRead::Miss(bytes) => Some(bytes),
            CachedRead::Oversized | CachedRead::Skipped => None,
        }
    }

    /// `true` when the bytes came from the cache rather than a fresh read.
    #[cfg(test)]
    pub(crate) fn is_hit(&self) -> bool {
        matches!(self, CachedRead::Hit(_))
    }
}

fn read_fresh_uncached(file: fs::File) -> CachedRead {
    match read_to_vec(file) {
        Ok(bytes) => CachedRead::Miss(Arc::new(bytes)),
        Err(_) => CachedRead::Skipped,
    }
}

fn read_to_vec(mut file: fs::File) -> std::io::Result<Vec<u8>> {
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;
    Ok(buffer)
}

/// Clear the entire filesystem scan cache.
///
/// Intended to be called after every agent file mutation (`file.edit` /
/// `file.write` / `file.patch`) so the next read/grep sees fresh content.
/// The TypeScript mutation queue registers a single invalidator pointing at
/// this function; when the addon is unavailable the call is a silent no-op.
#[napi]
pub fn invalidate_fs_scan_cache() {
    invalidate_all_inner();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    static FIXTURE_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn fixture_dir() -> PathBuf {
        let seq = FIXTURE_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "mc-natives-fs-cache-{}-{}",
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&dir).ok();
        dir
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(path, contents).ok();
    }

    /// Force the mtime to advance past `before` by writing repeatedly until
    /// the reported `modified()` strictly exceeds it. Works around FS mtime
    /// resolution differences (some report millis, some nanos).
    fn force_mtime_bump(path: &Path, before: SystemTime, payload: &str) {
        for _ in 0..50 {
            fs::write(path, payload).ok();
            if let Ok(meta) = fs::metadata(path) {
                if let Ok(mtime) = meta.modified() {
                    if mtime > before {
                        return;
                    }
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn current_mtime(path: &Path) -> SystemTime {
        fs::metadata(path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    }

    /// Extract bytes from a `CachedRead`, substituting an empty buffer when the
    /// read was `Oversized`/`Skipped` so the following `assert_eq!` fails loudly
    /// instead of needing `unwrap`/`expect` (denied crate-wide).
    fn into_bytes(read: CachedRead) -> Arc<Vec<u8>> {
        match read {
            CachedRead::Hit(bytes) | CachedRead::Miss(bytes) => bytes,
            CachedRead::Oversized | CachedRead::Skipped => Arc::new(Vec::new()),
        }
    }

    #[test]
    fn get_cached_misses_when_empty() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let file = dir.join("a.txt");
        write_file(&file, "hello\n");
        let mtime = current_mtime(&file);
        assert!(cache.get(&file, mtime).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn put_then_get_hits_on_same_mtime() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let file = dir.join("a.txt");
        write_file(&file, "alpha\n");
        let mtime = current_mtime(&file);
        cache.put(&file, mtime, Arc::new(b"alpha\n".to_vec()));
        let got = cache
            .get(&file, mtime)
            .unwrap_or_else(|| Arc::new(Vec::new()));
        assert_eq!(&*got, b"alpha\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_misses_on_changed_mtime() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let file = dir.join("a.txt");
        write_file(&file, "v1\n");
        let mtime_v1 = current_mtime(&file);
        cache.put(&file, mtime_v1, Arc::new(b"v1\n".to_vec()));
        let later = mtime_v1 + Duration::from_secs(60);
        assert!(cache.get(&file, later).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalidate_all_clears_every_entry() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        write_file(&a, "a\n");
        write_file(&b, "b\n");
        let a_mtime = current_mtime(&a);
        let b_mtime = current_mtime(&b);
        cache.put(&a, a_mtime, Arc::new(b"a\n".to_vec()));
        cache.put(&b, b_mtime, Arc::new(b"b\n".to_vec()));
        assert_eq!(cache.len(), 2);
        assert!(cache.get(&a, a_mtime).is_some());
        assert!(cache.get(&b, b_mtime).is_some());
        cache.invalidate_all();
        assert_eq!(cache.len(), 0);
        assert!(
            cache.get(&a, a_mtime).is_none(),
            "invalidate must drop entries"
        );
        assert!(
            cache.get(&b, b_mtime).is_none(),
            "invalidate must drop entries"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_bytes_cached_misses_then_hits() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let file = dir.join("a.txt");
        write_file(&file, "needle in a haystack\n");
        let first = cache.read_file_bytes_cached(&file, 4 * 1024 * 1024);
        assert!(!first.is_hit(), "first read must be a fresh miss");
        let first_bytes = into_bytes(first);
        assert_eq!(&*first_bytes, b"needle in a haystack\n");
        let second = cache.read_file_bytes_cached(&file, 4 * 1024 * 1024);
        assert!(second.is_hit(), "second read of unchanged file must hit");
        assert_eq!(&*into_bytes(second), &*first_bytes);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The TOCTOU guard: mutate the file between a cache-populating read and a
    /// later read; the changed mtime forces a fresh read so stale content is
    /// never served.
    #[test]
    fn read_file_bytes_cached_serves_fresh_after_mutation() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let file = dir.join("a.txt");
        write_file(&file, "ORIGINAL\n");
        let before = current_mtime(&file);

        let first = cache.read_file_bytes_cached(&file, 4 * 1024 * 1024);
        assert_eq!(&*into_bytes(first), b"ORIGINAL\n");

        force_mtime_bump(&file, before, "MUTATED\n");
        let after = cache.read_file_bytes_cached(&file, 4 * 1024 * 1024);
        assert!(
            !after.is_hit(),
            "mutated file must NOT serve the stale cache entry"
        );
        assert_eq!(&*into_bytes(after), b"MUTATED\n", "must read fresh content");

        let again = cache.read_file_bytes_cached(&file, 4 * 1024 * 1024);
        assert!(again.is_hit());
        assert_eq!(&*into_bytes(again), b"MUTATED\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalidate_clears_a_populated_read_cache() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let file = dir.join("a.txt");
        write_file(&file, "payload\n");
        let _ = into_bytes(cache.read_file_bytes_cached(&file, 4 * 1024 * 1024));
        let mtime = current_mtime(&file);
        assert!(
            cache.get(&file, mtime).is_some(),
            "read must populate the cache"
        );
        cache.invalidate_all();
        assert!(
            cache.get(&file, mtime).is_none(),
            "invalidate must drop the entry"
        );
        let again = cache.read_file_bytes_cached(&file, 4 * 1024 * 1024);
        assert!(!again.is_hit(), "post-invalidate read must miss");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_bytes_cached_oversized_is_not_cached() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let file = dir.join("big.txt");
        write_file(&file, &"a".repeat(32));
        let outcome = cache.read_file_bytes_cached(&file, 8);
        assert!(
            matches!(outcome, CachedRead::Oversized),
            "must be oversized"
        );
        assert!(
            cache.get(&file, current_mtime(&file)).is_none(),
            "oversized files must not populate the cache"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_bytes_cached_missing_file_is_skipped() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let missing = dir.join("does-not-exist.txt");
        let outcome = cache.read_file_bytes_cached(&missing, 4 * 1024 * 1024);
        assert!(matches!(outcome, CachedRead::Skipped));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn soft_cap_clears_on_overflow() {
        let cache = FsCache::new();
        let dir = fixture_dir();
        let mut first_key = None;
        for i in 0..MAX_CACHE_ENTRIES {
            let file = dir.join(format!("f{:04}.txt", i));
            write_file(&file, "x");
            let mtime = current_mtime(&file);
            if i == 0 {
                first_key = Some((file.clone(), mtime));
            }
            cache.put(&file, mtime, Arc::new(b"x".to_vec()));
        }
        assert_eq!(cache.len(), MAX_CACHE_ENTRIES);
        // The (MAX+1)-th insert trips the cap: the map clears, then the new
        // entry lands alone.
        let extra = dir.join("overflow.txt");
        write_file(&extra, "y");
        let extra_mtime = current_mtime(&extra);
        cache.put(&extra, extra_mtime, Arc::new(b"y".to_vec()));
        assert_eq!(
            cache.len(),
            1,
            "overflow must clear then insert the new entry"
        );
        if let Some((first_path, first_mtime)) = first_key {
            assert!(
                cache.get(&first_path, first_mtime).is_none(),
                "overflow clear must evict pre-clear entries"
            );
        }
        assert!(
            cache.get(&extra, extra_mtime).is_some(),
            "overflow key inserted after the clear must survive"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_key_path_passes_absolute_through() {
        let abs = Path::new("/tmp/mc-natives-resolve-key-abs.txt");
        assert_eq!(resolve_key_path(abs), abs.to_path_buf());
    }
}
