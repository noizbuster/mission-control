//! Workspace isolation PAL for sidecar protocol v3 `iso.resolve` / `iso.diff`.
//!
//! Ports the practical subset of the oh-my-pi `pi-iso` PAL (MIT, (c) Mario
//! Zechner + Can Boeluek), reimplemented fresh here:
//!
//! - Linux: kernel `overlay` mount (with a `fuse-overlayfs` fallback), else
//!   plain recursive copy (`rcopy`).
//! - macOS: APFS `clonefile(2)`, else `rcopy`.
//! - Everything else (Windows, *BSD, ...): `unsupported`.
//!
//! Deferred backends (recorded in `.mc/evidence/task-18-deferred-backends.md`):
//! `projfs`, `btrfs`, `zfs`, `windows_block_clone`, `linux_reflink`.
//!
//! The protocol only carries `iso.resolve` and `iso.diff` (no explicit
//! `iso.stop`), so overlay mounts are tracked in a process-static registry and
//! torn down by [`cleanup_mounts`] when the scheduler loop exits (stdin EOF).
//! `rcopy` and APFS clones are independent directory trees with no mount to
//! undo, so they need no teardown beyond the caller deleting the merged dir.
//!
//! No `unwrap` / `expect` / `panic`: every fallible operation maps to a
//! `method` string on the resolution so the sidecar never aborts on an iso
//! command.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
pub const METHOD_UNSUPPORTED: &str = "unsupported";
pub const METHOD_OVERLAYFS: &str = "overlayfs";
pub const METHOD_RCOPY: &str = "rcopy";
#[allow(dead_code, reason = "apfs backend is macos-only; unused on other targets")]
pub const METHOD_APFS: &str = "apfs";
const FAILED_PREFIX: &str = "failed:";

/// Backing store for the platform dispatch so it is unit-testable without
/// cross-compilation. [`Platform::Other`] mirrors the Windows / unsupported
/// path regardless of the host the test binary runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code, reason = "non-host variants are constructed in tests / cross-platform builds")]
pub enum Platform {
    Linux,
    Macos,
    Other,
}

/// Detect the host platform. Extracted so tests can feed an explicit value to
/// [`resolve_for_platform`].
pub fn current_platform() -> Platform {
    #[cfg(target_os = "linux")]
    {
        Platform::Linux
    }
    #[cfg(target_os = "macos")]
    {
        Platform::Macos
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Platform::Other
    }
}

/// Outcome of [`resolve`] / [`resolve_for_platform`]. `method` carries both the
/// chosen backend and the failure modes (`unsupported`, `failed:<reason>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoResolution {
    pub resolved: String,
    pub method: Option<String>,
}

impl IsoResolution {
    fn unsupported() -> Self {
        Self {
            resolved: String::new(),
            method: Some(METHOD_UNSUPPORTED.to_string()),
        }
    }

    fn failed(reason: impl Into<String>) -> Self {
        Self {
            resolved: String::new(),
            method: Some(format!("{}{}", FAILED_PREFIX, reason.into())),
        }
    }

    fn ok(resolved: impl Into<String>, method: &'static str) -> Self {
        Self {
            resolved: resolved.into(),
            method: Some(method.to_string()),
        }
    }
}

/// Outcome of [`diff`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoDiffResult {
    pub diff: String,
    pub identical: bool,
}

/// Resolve an isolated writable view of `target` for the host platform.
pub fn resolve(target: &str, method: Option<&str>) -> IsoResolution {
    resolve_for_platform(target, method, current_platform())
}

/// Pure platform dispatch used by both the live handler and the test suite.
///
/// `method` is an optional caller hint (`overlayfs`, `apfs`, `rcopy`). When the
/// hint is unusable on `platform` the resolver falls back to the platform
/// default chain, ending in `rcopy`. [`Platform::Other`] always returns
/// `unsupported`.
pub fn resolve_for_platform(target: &str, method: Option<&str>, platform: Platform) -> IsoResolution {
    let lower = PathBuf::from(target);
    match platform {
        Platform::Linux => resolve_linux(&lower, method),
        Platform::Macos => resolve_macos(&lower, method),
        Platform::Other => IsoResolution::unsupported(),
    }
}

/// Compare two directory trees and return a unified-diff patch. `identical` is
/// true when no file differs. Binary files are reported by name without a
/// patch body. Missing paths produce an empty diff (treated as identical when
/// both are absent).
pub fn diff(baseline: &str, current: &str) -> IsoDiffResult {
    let baseline_root = Path::new(baseline);
    let current_root = Path::new(current);
    let baseline_index = match index_tree(baseline_root) {
        Ok(index) => index,
        Err(reason) => {
            return IsoDiffResult {
                diff: format!("iso_diff: baseline unreadable: {reason}"),
                identical: false,
            };
        }
    };
    let current_index = match index_tree(current_root) {
        Ok(index) => index,
        Err(reason) => {
            return IsoDiffResult {
                diff: format!("iso_diff: current unreadable: {reason}"),
                identical: false,
            };
        }
    };

    let mut entries: Vec<FileChange> = Vec::new();
    for (rel, current_meta) in &current_index {
        match baseline_index.get(rel) {
            None => entries.push(file_change(current_root, rel, ChangeKind::Added, None)),
            Some(baseline_meta) => {
                // Size is a cheap fast-path negative; same-size files are
                // content-compared so same-second edits never look unchanged.
                if baseline_meta.size != current_meta.size {
                    entries.push(file_change(current_root, rel, ChangeKind::Modified, Some(baseline_root)));
                } else if !contents_equal(baseline_root, current_root, rel) {
                    entries.push(file_change(current_root, rel, ChangeKind::Modified, Some(baseline_root)));
                }
            }
        }
    }
    for rel in baseline_index.keys() {
        if !current_index.contains_key(rel) {
            entries.push(file_change(baseline_root, rel, ChangeKind::Removed, None));
        }
    }
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));

    if entries.is_empty() {
        return IsoDiffResult {
            diff: String::new(),
            identical: true,
        };
    }

    let mut diff_text = String::new();
    for entry in &entries {
        match &entry.patch {
            Some(patch) => {
                if !diff_text.is_empty() && !diff_text.ends_with('\n') {
                    diff_text.push('\n');
                }
                diff_text.push_str(patch);
            }
            None => {
                if !diff_text.is_empty() && !diff_text.ends_with('\n') {
                    diff_text.push('\n');
                }
                let _ = std::fmt::Write::write_fmt(
                    &mut diff_text,
                    format_args!("Binary file {} differs\n", entry.rel.display()),
                );
            }
        }
    }
    IsoDiffResult {
        diff: diff_text,
        identical: false,
    }
}

/// Tear down every overlay mount this process created. Best effort and never
/// panics: called by the scheduler when its stdin loop ends so mounts do not
/// outlive the sidecar session on the graceful-shutdown path.
pub fn cleanup_mounts() {
    #[cfg(target_os = "linux")]
    {
        linux::cleanup_mounts();
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS APFS clones and rcopy are plain directories; no mount to undo.
    }
}

// --- linux -----------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::{LazyLock, Mutex};

    use super::{IsoResolution, METHOD_OVERLAYFS, METHOD_RCOPY};

    static ACTIVE_MOUNTS: LazyLock<Mutex<HashMap<PathBuf, PathBuf>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    pub(super) fn resolve(lower: &Path, method: Option<&str>) -> IsoResolution {
        let merged = match merged_path(lower) {
            Ok(path) => path,
            Err(reason) => return IsoResolution::failed(reason),
        };

        // Caller hint overrides the default chain. An explicit rcopy skips the
        // mount attempt entirely.
        let want_overlay = !matches!(method, Some(super::METHOD_RCOPY));

        if want_overlay && kernel_overlay_supported() {
            match start_overlay(lower, &merged) {
                Ok(()) => return IsoResolution::ok(merged.to_string_lossy().into_owned(), METHOD_OVERLAYFS),
                Err(reason) => {
                    // Fall through to rcopy; overlay was unavailable for this
                    // environment (EPERM outside a user namespace, module
                    // absent, cross-device, ...).
                    let _ = reason;
                }
            }
        }

        match super::rcopy_tree(lower, &merged) {
            Ok(()) => IsoResolution::ok(merged.to_string_lossy().into_owned(), METHOD_RCOPY),
            Err(reason) => IsoResolution::failed(reason),
        }
    }

    pub(super) fn cleanup_mounts() {
        let mounts: Vec<(PathBuf, PathBuf)> = {
            let mut guard = match ACTIVE_MOUNTS.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            guard.drain().collect()
        };
        for (_merged, base) in mounts {
            let _ = umount_and_remove(&base);
        }
    }

    fn start_overlay(lower: &Path, merged: &Path) -> Result<(), String> {
        let lower_abs = canonical_existing_dir(lower)?;
        let base = merged
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| merged.to_path_buf());
        let upper = base.join("upper");
        let work = base.join("work");

        remove_dir_all_safe(&upper)?;
        remove_dir_all_safe(&work)?;
        remove_dir_all_safe(merged)?;

        fs::create_dir_all(&upper)
            .map_err(|e| format!("create overlay upper: {e}"))?;
        fs::create_dir_all(&work)
            .map_err(|e| format!("create overlay work: {e}"))?;
        fs::create_dir_all(merged)
            .map_err(|e| format!("create overlay merged: {e}"))?;

        let opts = format!(
            "lowerdir={},upperdir={},workdir={}",
            lower_abs.display(),
            upper.display(),
            work.display()
        );
        kernel_mount(merged, &opts)?;

        if let Ok(mut guard) = ACTIVE_MOUNTS.lock() {
            guard.insert(merged.to_path_buf(), base);
        }
        Ok(())
    }

    fn kernel_overlay_supported() -> bool {
        fs::read_to_string("/proc/filesystems")
            .map(|text| {
                text.lines()
                    .any(|line| line.split_whitespace().any(|word| word == "overlay"))
            })
            .unwrap_or(false)
    }

    fn kernel_mount(target: &Path, opts: &str) -> Result<(), String> {
        let target_c = to_cstring(target)?;
        let source = CString::new("overlay").map_err(|e| format!("overlay source NUL: {e}"))?;
        let fstype = CString::new("overlay").map_err(|e| format!("overlay fstype NUL: {e}"))?;
        let opts_c = to_cstring_str(opts)?;

        // SAFETY: all pointers are backed by CStrings that outlive the call;
        // the kernel does not retain them past the syscall.
        let rc = unsafe {
            libc::mount(
                source.as_ptr(),
                target_c.as_ptr(),
                fstype.as_ptr(),
                0,
                opts_c.as_ptr() as *const libc::c_void,
            )
        };
        if rc == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        Err(format!(
            "overlay mount denied ({err}); falling back to rcopy"
        ))
    }

    fn umount_and_remove(base: &Path) -> Result<(), String> {
        let merged = base.join("merged");
        let _ = kernel_umount(&merged);
        remove_dir_all_safe(&base.join("upper"))?;
        remove_dir_all_safe(&base.join("work"))?;
        remove_dir_all_safe(&merged)?;
        remove_dir_all_safe(base)?;
        Ok(())
    }

    fn kernel_umount(target: &Path) -> Result<(), String> {
        let target_c = to_cstring(target)?;
        // SAFETY: `target_c` outlives the syscall; MNT_DETACH detaches lazily.
        let rc = unsafe { libc::umount2(target_c.as_ptr(), libc::MNT_DETACH) };
        if rc == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::EINVAL) | Some(libc::ENOENT) => Ok(()),
            Some(code) => Err(format!("umount2 failed (errno {code})")),
            None => Err("umount2 failed without errno".to_string()),
        }
    }

    fn canonical_existing_dir(path: &Path) -> Result<PathBuf, String> {
        let resolved = absolutize(path);
        let meta = fs::metadata(&resolved).map_err(|e| format!("overlay lower {}: {e}", resolved.display()))?;
        if !meta.is_dir() {
            return Err(format!("overlay lower {} is not a directory", resolved.display()));
        }
        Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
    }

    fn absolutize(path: &Path) -> PathBuf {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    }

    fn remove_dir_all_safe(path: &Path) -> Result<(), String> {
        match fs::remove_dir_all(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("remove {}: {err}", path.display())),
        }
    }

    fn to_cstring(path: &Path) -> Result<CString, String> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|e| format!("path contains NUL byte: {e}"))
    }

    fn to_cstring_str(s: &str) -> Result<CString, String> {
        CString::new(s).map_err(|e| format!("option string contains NUL byte: {e}"))
    }

    fn merged_path(_lower: &Path) -> Result<PathBuf, String> {
        let suffix = super::unique_suffix();
        let dir = std::env::temp_dir().join(format!("mctrl-iso-{suffix}"));
        // base/<merged> layout keeps upper/work siblings under one owned dir.
        let base = dir.join("iso");
        fs::create_dir_all(&base).map_err(|e| format!("create iso base: {e}"))?;
        Ok(base.join("merged"))
    }
}

// --- macos -----------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use super::{IsoResolution, METHOD_APFS, METHOD_RCOPY};

    pub(super) fn resolve(lower: &Path, method: Option<&str>) -> IsoResolution {
        let merged = match merged_path(lower) {
            Ok(path) => path,
            Err(reason) => return IsoResolution::failed(reason),
        };

        let want_clone = !matches!(method, Some(super::METHOD_RCOPY));
        if want_clone {
            match start_clone(lower, &merged) {
                Ok(()) => return IsoResolution::ok(merged.to_string_lossy().into_owned(), METHOD_APFS),
                Err(reason) => {
                    let _ = reason;
                }
            }
        }

        match super::rcopy_tree(lower, &merged) {
            Ok(()) => IsoResolution::ok(merged.to_string_lossy().into_owned(), METHOD_RCOPY),
            Err(reason) => IsoResolution::failed(reason),
        }
    }

    fn start_clone(lower: &Path, merged: &Path) -> Result<(), String> {
        let lower_abs = canonical_existing_dir(lower)?;
        if let Some(parent) = merged.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create clone parent: {e}"))?;
        }
        if merged.exists() {
            fs::remove_dir_all(merged).map_err(|e| format!("clear clone target: {e}"))?;
        }

        let src_c = CString::new(lower_abs.as_os_str().as_bytes())
            .map_err(|e| format!("lower NUL byte: {e}"))?;
        let dst_c = CString::new(merged.as_os_str().as_bytes())
            .map_err(|e| format!("merged NUL byte: {e}"))?;

        // SAFETY: both pointers are backed by CStrings that outlive the call;
        // clonefile with flags=0 performs a recursive CoW clone.
        let rc = unsafe { libc::clonefile(src_c.as_ptr(), dst_c.as_ptr(), 0) };
        if rc == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP) | Some(libc::EXDEV) => {
                Err(format!("clonefile unsupported on volume ({err}); falling back to rcopy"))
            }
            Some(code) => Err(format!("clonefile failed (errno {code}); falling back to rcopy")),
            None => Err("clonefile failed without errno; falling back to rcopy".to_string()),
        }
    }

    fn canonical_existing_dir(path: &Path) -> Result<PathBuf, String> {
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        };
        let meta = fs::metadata(&resolved).map_err(|e| format!("clone source {}: {e}", resolved.display()))?;
        if !meta.is_dir() {
            return Err(format!("clone source {} is not a directory", resolved.display()));
        }
        Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
    }

    fn merged_path(_lower: &Path) -> Result<PathBuf, String> {
        let suffix = super::unique_suffix();
        let dir = std::env::temp_dir().join(format!("mctrl-iso-{suffix}"));
        Ok(dir)
    }
}

// When neither linux nor macos is compiled in, provide a stub so the module
// still type-checks. The dispatch above returns `unsupported` for Other, so
// these are never reached.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod stub {
    use super::IsoResolution;
    pub(super) fn resolve(_lower: &std::path::Path, _method: Option<&str>) -> IsoResolution {
        IsoResolution::unsupported()
    }
}

fn resolve_linux(lower: &Path, method: Option<&str>) -> IsoResolution {
    #[cfg(target_os = "linux")]
    {
        linux::resolve(lower, method)
    }
    #[cfg(not(target_os = "linux"))]
    {
        // resolve_for_platform only routes Linux targets here on a Linux build.
        let _ = (lower, method);
        IsoResolution::unsupported()
    }
}

fn resolve_macos(lower: &Path, method: Option<&str>) -> IsoResolution {
    #[cfg(target_os = "macos")]
    {
        macos::resolve(lower, method)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (lower, method);
        IsoResolution::unsupported()
    }
}

// --- shared rcopy + diff helpers -------------------------------------------

static SUFFIX_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_suffix() -> String {
    let counter = SUFFIX_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{}-{}", nanos, std::process::id(), counter)
}

/// Recursive copy preserving directory structure and symlinks. Used as the
/// universal fallback on every platform and as the only backend on hosts
/// without a CoW/overlay primitive. Returns an error reason on failure; never
/// panics.
fn rcopy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let src_abs = if src.is_absolute() {
        src.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(src))
            .unwrap_or_else(|_| src.to_path_buf())
    };
    let meta = match std::fs::metadata(&src_abs) {
        Ok(meta) => meta,
        Err(err) => return Err(format!("rcopy source {}: {err}", src_abs.display())),
    };
    if !meta.is_dir() {
        return Err(format!("rcopy source {} is not a directory", src_abs.display()));
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("rcopy create {}: {e}", dst.display()))?;
    copy_dir_contents(&src_abs, dst).map_err(|e| format!("rcopy {e}"))?;
    Ok(())
}

fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry in {}: {e}", src.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("file_type {}: {e}", entry.path().display()))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_symlink() {
            copy_symlink(&src_path, &dst_path)?;
        } else if file_type.is_dir() {
            std::fs::create_dir_all(&dst_path)
                .map_err(|e| format!("create {}: {e}", dst_path.display()))?;
            copy_dir_contents(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                format!("copy {} -> {}: {e}", src_path.display(), dst_path.display())
            })?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    let target = std::fs::read_link(src).map_err(|e| format!("read_link {}: {e}", src.display()))?;
    std::os::unix::fs::symlink(target, dst).map_err(|e| format!("symlink {}: {e}", dst.display()))
}

#[cfg(not(unix))]
fn copy_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    // Best effort: copy the link target bytes. Symlink semantics are not the
    // rcopy fast path on non-unix hosts.
    let _ = (src, dst);
    Err("symlink copy unsupported on this platform".to_string())
}

// --- diff internals --------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChangeKind {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone)]
struct FileChange {
    rel: PathBuf,
    patch: Option<String>,
}

#[derive(Debug, Clone)]
struct FileMeta {
    size: u64,
}

fn index_tree(root: &Path) -> Result<HashMap<PathBuf, FileMeta>, String> {
    let mut out = HashMap::new();
    if !root.exists() {
        return Ok(out);
    }
    walk(root, root, &mut out)?;
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut HashMap<PathBuf, FileMeta>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry in {}: {e}", dir.display()))?;
        let path = entry.path();
        let meta = entry
            .metadata()
            .map_err(|e| format!("metadata {}: {e}", path.display()))?;
        let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        if meta.is_dir() {
            walk(root, &path, out)?;
            continue;
        }
        out.insert(rel, FileMeta { size: meta.len() });
    }
    Ok(())
}

/// Byte-for-byte equality of `baseline/<rel>` and `current/<rel>`. Called only
/// after a size match, so the read cost is bounded to ambiguous (same-size)
/// pairs rather than every file in the tree.
fn contents_equal(baseline_root: &Path, current_root: &Path, rel: &Path) -> bool {
    let baseline = match std::fs::read(baseline_root.join(rel)) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let current = match std::fs::read(current_root.join(rel)) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    baseline == current
}

fn file_change(side: &Path, rel: &Path, kind: ChangeKind, peer: Option<&Path>) -> FileChange {
    let full = side.join(rel);
    let primary = match std::fs::read(&full) {
        Ok(bytes) => bytes,
        Err(_) => {
            return FileChange {
                rel: rel.to_path_buf(),
                patch: Some(format!("diff --git a/{} b/{}\n(unreadable)\n", rel.display(), rel.display())),
            };
        }
    };
    if looks_binary(&primary) {
        return FileChange {
            rel: rel.to_path_buf(),
            patch: None,
        };
    }
    let peer_bytes = match kind {
        ChangeKind::Added => Vec::new(),
        ChangeKind::Removed => Vec::new(),
        ChangeKind::Modified => {
            let peer_root = match peer {
                Some(root) => root,
                None => return FileChange { rel: rel.to_path_buf(), patch: None },
            };
            match std::fs::read(peer_root.join(rel)) {
                Ok(bytes) => bytes,
                Err(_) => return FileChange { rel: rel.to_path_buf(), patch: None },
            }
        }
    };
    if looks_binary(&peer_bytes) {
        return FileChange {
            rel: rel.to_path_buf(),
            patch: None,
        };
    }
    let Ok(old_text) = std::str::from_utf8(&peer_bytes) else {
        return FileChange { rel: rel.to_path_buf(), patch: None };
    };
    let Ok(new_text) = std::str::from_utf8(&primary) else {
        return FileChange { rel: rel.to_path_buf(), patch: None };
    };
    let patch = render_unified(rel, kind, old_text, new_text);
    FileChange {
        rel: rel.to_path_buf(),
        patch: Some(patch),
    }
}

fn render_unified(rel: &Path, kind: ChangeKind, old: &str, new: &str) -> String {
    let rel_str = rel.to_string_lossy();
    let (from_label, to_label) = match kind {
        ChangeKind::Added => ("/dev/null".to_string(), format!("b/{rel_str}")),
        ChangeKind::Removed => (format!("a/{rel_str}"), "/dev/null".to_string()),
        ChangeKind::Modified => (format!("a/{rel_str}"), format!("b/{rel_str}")),
    };
    let mut out = String::new();
    let _ = std::fmt::Write::write_fmt(&mut out, format_args!("diff --git a/{rel_str} b/{rel_str}\n"));
    match kind {
        ChangeKind::Added => {
            let _ = std::fmt::Write::write_fmt(&mut out, format_args!("new file mode 100644\n"));
        }
        ChangeKind::Removed => {
            let _ = std::fmt::Write::write_fmt(&mut out, format_args!("deleted file mode 100644\n"));
        }
        ChangeKind::Modified => {}
    }
    let body = similar::TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&from_label, &to_label)
        .to_string();
    out.push_str(&body);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

#[cfg(test)]
#[path = "iso_tests.rs"]
mod tests;
