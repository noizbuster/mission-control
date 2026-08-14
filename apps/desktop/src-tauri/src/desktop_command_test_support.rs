use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Seeds a pending file.patch approval through the authoritative local store path
/// (`openLocalSessionEventStore` + `store.append`), minting `desktop_tool_proposals`.
pub(crate) fn seed_authoritative_pending_file_patch_approval(
    data_dir: &Path,
    session_id: &str,
    approval_id: &str,
    file_path: &str,
    content: &str,
) -> Result<(), Box<dyn Error>> {
    run_seed_fixture(&[
        "--mode",
        "pending-approval",
        "--dataDir",
        &path_string(data_dir)?,
        "--sessionId",
        session_id,
        "--approvalId",
        approval_id,
        "--tool",
        "file.patch",
        "--filePath",
        file_path,
        "--content",
        content,
    ])
}

/// Seeds a pending command.run approval through the authoritative local store path.
pub(crate) fn seed_authoritative_pending_command_approval(
    data_dir: &Path,
    session_id: &str,
    approval_id: &str,
) -> Result<(), Box<dyn Error>> {
    run_seed_fixture(&[
        "--mode",
        "pending-approval",
        "--dataDir",
        &path_string(data_dir)?,
        "--sessionId",
        session_id,
        "--approvalId",
        approval_id,
        "--tool",
        "command.run",
    ])
}

/// Seeds a durable unknown approval effect (reserve + claim + expired recovery).
/// Operator resolution records completed/failed without replaying the tool.
pub(crate) fn seed_durable_unknown_approval_effect(
    data_dir: &Path,
    session_id: &str,
    approval_id: &str,
    workspace_root: &Path,
) -> Result<(), Box<dyn Error>> {
    run_seed_fixture(&[
        "--mode",
        "unknown-effect",
        "--dataDir",
        &path_string(data_dir)?,
        "--sessionId",
        session_id,
        "--approvalId",
        approval_id,
        "--workspaceRoot",
        &path_string(workspace_root)?,
    ])
}

/// Imported-session seed for the imported-approval inert regression: the same
/// approval events as the authoritative seed, but written through the
/// non-authoritative import path (envelopes only — NO `desktop_tool_proposals`).
pub(crate) fn seed_imported_pending_file_patch_approval(
    data_dir: &Path,
    session_id: &str,
    approval_id: &str,
    file_path: &str,
    content: &str,
) -> Result<(), Box<dyn Error>> {
    run_seed_fixture(&[
        "--mode",
        "imported-approval",
        "--dataDir",
        &path_string(data_dir)?,
        "--sessionId",
        session_id,
        "--approvalId",
        approval_id,
        "--tool",
        "file.patch",
        "--filePath",
        file_path,
        "--content",
        content,
    ])
}

pub(crate) fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}

fn run_seed_fixture(args: &[&str]) -> Result<(), Box<dyn Error>> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("test-fixtures")
        .join("seed-authoritative-pending-approval.mjs");
    let node = std::env::var("MISSION_CONTROL_NODE").unwrap_or_else(|_| "node".to_owned());
    // Resolve @mission-control/core from the desktop package workspace.
    let desktop_package_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("could not resolve desktop package dir")?
        .to_path_buf();
    let output = Command::new(node)
        .arg(&script)
        .args(args)
        .current_dir(&desktop_package_dir)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "seed fixture failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}

fn path_string(path: &Path) -> Result<String, Box<dyn Error>> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()).into())
}
