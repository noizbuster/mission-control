use crate::desktop_command_test_support::{
    seed_pending_command_approval, seed_pending_file_patch_approval, temp_data_dir,
};
use crate::desktop_commands::{decide_approval_with_bridge, DesktopApprovalDecisionInput};
use crate::sessions::{read_session_events_from_data_dir, SessionLogState};
use std::error::Error;
use std::fs::{create_dir_all, read_to_string, remove_dir_all};
use std::path::{Path, PathBuf};

#[test]
fn approved_file_patch_writes_workspace_file_through_core_bridge() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("approved-patch-bridge")?;
    let workspace_root = temp_data_dir("approved-patch-workspace")?;
    create_dir_all(&workspace_root)?;
    let bridge = crate::desktop_command_bridge::DesktopCommandBridge::with_workspace_root(
        workspace_root.clone(),
    )?;
    let approval = DesktopApprovalDecisionInput {
        session_id: "session_bridge_approved_patch".to_owned(),
        approval_id: "approval_permission_call_patch_allowed".to_owned(),
        state: "approved".to_owned(),
        reason: Some("approved".to_owned()),
    };
    seed_pending_file_patch_approval(
        &data_dir,
        "session_bridge_approved_patch",
        "approval_permission_call_patch_allowed",
        "approved.txt",
        "approved write",
    )?;

    let decided = decide_approval_with_bridge(approval, &data_dir, &bridge)?;
    let written = read_to_string(workspace_root.join("approved.txt"))?;
    let log = read_session_events_from_data_dir(&data_dir, "session_bridge_approved_patch")?;

    assert_eq!(decided.status, "completed");
    assert!(decided.events_written > 0);
    assert_eq!(written, "approved write\n");
    assert_eq!(log.state, SessionLogState::Available);
    assert!(event_types(&log).contains(&"approval.updated".to_owned()));
    assert!(event_types(&log).contains(&"approval.resumed".to_owned()));
    assert!(event_types(&log).contains(&"file.diff.applied".to_owned()));
    assert!(event_types(&log).contains(&"tool.completed".to_owned()));
    assert!(!event_types(&log).contains(&"run.failed".to_owned()));
    remove_dir_all(data_dir)?;
    remove_dir_all(workspace_root)?;
    Ok(())
}

#[test]
fn approved_command_run_persists_command_settlement_through_core_bridge(
) -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("approved-command-bridge")?;
    let workspace_root = repo_root()?;
    let bridge =
        crate::desktop_command_bridge::DesktopCommandBridge::with_workspace_root(workspace_root)?;
    let approval = DesktopApprovalDecisionInput {
        session_id: "session_bridge_approved_command".to_owned(),
        approval_id: "approval_permission_call_command_allowed".to_owned(),
        state: "approved".to_owned(),
        reason: Some("approved".to_owned()),
    };
    seed_pending_command_approval(
        &data_dir,
        "session_bridge_approved_command",
        "approval_permission_call_command_allowed",
    )?;

    let decided = decide_approval_with_bridge(approval, &data_dir, &bridge)?;
    let log = read_session_events_from_data_dir(&data_dir, "session_bridge_approved_command")?;

    assert_eq!(decided.status, "completed");
    assert!(decided.events_written > 0);
    assert_eq!(log.state, SessionLogState::Available);
    assert!(event_types(&log).contains(&"approval.updated".to_owned()));
    assert!(event_types(&log).contains(&"approval.resumed".to_owned()));
    assert!(event_types(&log).contains(&"command.completed".to_owned()));
    assert!(event_types(&log).contains(&"tool.completed".to_owned()));
    assert!(!event_types(&log).contains(&"run.failed".to_owned()));
    remove_dir_all(data_dir)?;
    Ok(())
}
fn event_types(log: &crate::sessions::DesktopSessionLog) -> Vec<String> {
    log.envelopes
        .iter()
        .filter_map(|envelope| {
            envelope
                .get("event")
                .and_then(|event| event.get("type"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let Some(repo_root) = manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
    else {
        return Err(format!(
            "could not resolve repo root from {}",
            manifest_dir.display()
        )
        .into());
    };
    Ok(repo_root.to_path_buf())
}
