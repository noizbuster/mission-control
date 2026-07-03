use super::{IsoResolution, Platform, current_platform, diff, resolve, resolve_for_platform};
use std::fs;
use std::path::Path;

fn write_file(dir: &Path, rel: &str, body: &str) {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, body).expect("write file");
}

fn read_file(dir: &Path, rel: &str) -> String {
    fs::read_to_string(dir.join(rel)).expect("read file")
}

fn temp_dir(name: &str) -> tempfile::TempDir {
    let prefix = format!("mctrl-iso-test-{name}-");
    tempfile::Builder::new()
        .prefix(&prefix)
        .tempdir()
        .expect("temp dir")
}

#[test]
fn unsupported_platform_returns_unsupported_regardless_of_method() {
    let tmp = temp_dir("unsupported");
    let target = tmp.path().join("src");
    fs::create_dir_all(&target).expect("create src");

    let resolution = resolve_for_platform(
        target.to_str().expect("utf8 path"),
        Some("overlayfs"),
        Platform::Other,
    );

    assert_eq!(resolution.resolved, "");
    assert_eq!(resolution.method.as_deref(), Some(super::METHOD_UNSUPPORTED));
}

#[test]
fn unsupported_platform_with_no_method_hint_also_unsupported() {
    let tmp = temp_dir("unsupported-nohint");
    let target = tmp.path().join("src");
    fs::create_dir_all(&target).expect("create src");

    let resolution = resolve_for_platform(
        target.to_str().expect("utf8 path"),
        None,
        Platform::Other,
    );

    assert!(matches!(
        resolution.method.as_deref(),
        Some("unsupported")
    ));
    assert!(resolution.resolved.is_empty());
}

#[test]
fn resolve_on_host_produces_independent_worktree() {
    // The host (linux CI) typically denies overlay mount (EPERM outside a
    // user namespace), so this exercises the rcopy fallback path. rcopy gives
    // a real independent copy, so the isolation assertion holds regardless of
    // which backend the PAL selected.
    let src = temp_dir("src");
    let nested = src.path().join("nested");
    fs::create_dir_all(&nested).expect("create nested");
    write_file(src.path(), "keep.txt", "alpha\n");
    write_file(&nested, "deep.txt", "deep-alpha\n");

    let resolution = resolve(src.path().to_str().expect("utf8 src"), None);

    if resolution.resolved.is_empty() {
        // A total failure is a defect, not a graceful unsupported signal on a
        // linux/macos host. Surface the reason so the test fails loudly.
        panic!(
            "resolve returned no path on {:?}: method={:?}",
            current_platform(),
            resolution.method
        );
    }

    let method = resolution.method.as_deref().unwrap_or("unknown");
    assert!(
        matches!(method, super::METHOD_RCOPY | super::METHOD_OVERLAYFS | super::METHOD_APFS),
        "unexpected method: {method}"
    );

    let merged = Path::new(&resolution.resolved);

    // Merged mirrors the source at resolve time.
    assert_eq!(read_file(merged, "keep.txt"), "alpha\n");
    assert_eq!(read_file(merged, "nested/deep.txt"), "deep-alpha\n");

    // Adversarial: a write inside the worktree must NOT appear in the source.
    write_file(merged, "only-in-worktree.txt", "worktree-only\n");
    assert!(
        !merged.join("only-in-worktree.txt").starts_with(src.path()),
        "merged path should not be nested inside the source tree"
    );
    assert!(
        !src.path().join("only-in-worktree.txt").exists(),
        "worktree-only write leaked into the source tree (isolation broken)"
    );
}

#[test]
fn diff_reports_only_worktree_changes() {
    let src = temp_dir("diff-src");
    write_file(src.path(), "unchanged.txt", "same\n");
    write_file(src.path(), "will-change.txt", "before\n");

    let resolution = resolve(src.path().to_str().expect("utf8 src"), None);
    if resolution.resolved.is_empty() {
        panic!(
            "resolve failed on {:?}: {:?}",
            current_platform(),
            resolution.method
        );
    }
    let merged = Path::new(&resolution.resolved);

    // Simulate the child agent doing work in the isolated worktree.
    write_file(merged, "will-change.txt", "after\n");
    write_file(merged, "added.txt", "new content\n");

    let outcome = diff(
        src.path().to_str().expect("utf8 baseline"),
        merged.to_str().expect("utf8 current"),
    );

    assert!(
        !outcome.identical,
        "diff should report changes after worktree edits"
    );
    assert!(
        outcome.diff.contains("will-change.txt"),
        "diff should mention the modified file, got: {}",
        outcome.diff
    );
    assert!(
        outcome.diff.contains("added.txt"),
        "diff should mention the added file, got: {}",
        outcome.diff
    );
    // The unchanged file must NOT appear in the change set.
    assert!(
        !outcome.diff.contains("unchanged.txt"),
        "unchanged file leaked into the diff: {}",
        outcome.diff
    );
}

#[test]
fn diff_identical_trees_produce_empty_patch() {
    let a = temp_dir("identical-a");
    let b = temp_dir("identical-b");
    write_file(a.path(), "file.txt", "same content\n");
    write_file(b.path(), "file.txt", "same content\n");

    let outcome = diff(
        a.path().to_str().expect("utf8 a"),
        b.path().to_str().expect("utf8 b"),
    );

    assert!(outcome.identical, "identical trees should report identical");
    assert!(outcome.diff.is_empty(), "identical trees should have empty diff");
}

#[test]
fn resolve_missing_source_records_failure_without_panicking() {
    let resolution = resolve("/nonexistent/mctrl-iso-source-12345", None);

    // Never panics. Either unsupported (Other platform) or failed:<reason>
    // (linux/macos), but never a real resolved path.
    assert!(
        resolution.resolved.is_empty(),
        "resolving a missing source should not claim a resolved path"
    );
    let method = resolution.method.as_deref().unwrap_or("");
    assert!(
        method == "unsupported" || method.starts_with("failed:"),
        "unexpected method for missing source: {method}"
    );
}

#[test]
fn resolve_explicit_rcopy_hint_skips_overlay() {
    let src = temp_dir("rcopy-hint");
    write_file(src.path(), "a.txt", "a\n");

    let resolution = resolve_for_platform(
        src.path().to_str().expect("utf8 src"),
        Some(super::METHOD_RCOPY),
        Platform::Linux,
    );

    // On Linux with an explicit rcopy hint the overlay attempt is skipped, so
    // the method must be rcopy (or failed if the copy itself broke).
    let method = resolution.method.as_deref().unwrap_or("");
    assert!(
        method == super::METHOD_RCOPY || method.starts_with("failed:"),
        "explicit rcopy hint should yield rcopy, got: {method}"
    );
}

#[test]
fn diff_binary_files_reported_without_patch_body() {
    let a = temp_dir("binary-a");
    let b = temp_dir("binary-b");
    fs::write(a.path().join("blob.bin"), [0u8, 1, 0, 2]).expect("write a");
    fs::write(b.path().join("blob.bin"), [0u8, 9, 0, 9]).expect("write b");

    let outcome = diff(
        a.path().to_str().expect("utf8 a"),
        b.path().to_str().expect("utf8 b"),
    );

    assert!(!outcome.identical);
    assert!(
        outcome.diff.contains("Binary file") || outcome.diff.contains("blob.bin"),
        "binary diff should name the file: {}",
        outcome.diff
    );
}

#[test]
fn iso_resolution_constructors_are_consistent() {
    let ok = IsoResolution::ok("/tmp/x", super::METHOD_RCOPY);
    assert_eq!(ok.resolved, "/tmp/x");
    assert_eq!(ok.method.as_deref(), Some(super::METHOD_RCOPY));

    let unsup = IsoResolution::unsupported();
    assert!(unsup.resolved.is_empty());
    assert_eq!(unsup.method.as_deref(), Some(super::METHOD_UNSUPPORTED));

    let failed = IsoResolution::failed("disk full");
    assert!(failed.resolved.is_empty());
    assert_eq!(failed.method.as_deref(), Some("failed:disk full"));
}
