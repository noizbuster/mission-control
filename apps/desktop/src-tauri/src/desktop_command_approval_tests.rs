use crate::desktop_command_test_support::{
    seed_authoritative_pending_command_approval, seed_authoritative_pending_file_patch_approval,
    seed_durable_unknown_approval_effect, temp_data_dir,
};
use crate::desktop_commands::{
    DesktopApprovalDecisionInput, DesktopApprovalEffectOutcome,
    DesktopApprovalEffectResolutionInput, decide_approval_with_bridge,
    get_approval_effect_in_data_dir, read_session_events_from_data_dir,
    resolve_approval_effect_in_data_dir,
};
use crate::sessions::SessionLogState;
use std::error::Error;
use std::fs::{create_dir_all, read_to_string, remove_dir_all};
use std::path::{Path, PathBuf};

#[test]
fn approved_file_patch_writes_workspace_file_through_core_bridge() -> Result<(), Box<dyn Error>> {
    // Given: an authoritative local store seed with a pending file.patch proposal.
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
    seed_authoritative_pending_file_patch_approval(
        &data_dir,
        "session_bridge_approved_patch",
        "approval_permission_call_patch_allowed",
        "approved.txt",
        "approved write",
    )?;

    // When: the operator approves through the Tauri core bridge.
    let decided = decide_approval_with_bridge(approval, &data_dir, &bridge)?;
    let written = read_to_string(workspace_root.join("approved.txt"))?;
    let log = read_session_events_from_data_dir(&data_dir, "session_bridge_approved_patch")?;

    // Then: the tool executes once and settlement events are durable.
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
fn approved_command_run_persists_command_settlement_through_core_bridge()
-> Result<(), Box<dyn Error>> {
    // Given: an authoritative local store seed with a pending command.run proposal.
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
    seed_authoritative_pending_command_approval(
        &data_dir,
        "session_bridge_approved_command",
        "approval_permission_call_command_allowed",
    )?;

    // When: the operator approves through the Tauri core bridge.
    let decided = decide_approval_with_bridge(approval, &data_dir, &bridge)?;
    let log = read_session_events_from_data_dir(&data_dir, "session_bridge_approved_command")?;

    // Then: command settlement is durable without a failed run.
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

#[test]
fn durable_unknown_effect_resolution_records_completed_without_tool_execution()
-> Result<(), Box<dyn Error>> {
    // Given: a durable unknown effect after an expired execution claim.
    let data_dir = temp_data_dir("unknown-effect-completed")?;
    let workspace_root = temp_data_dir("unknown-effect-completed-workspace")?;
    create_dir_all(&workspace_root)?;
    let session_id = "session_unknown_effect_completed";
    let approval_id = "approval_permission_call_unknown_completed";
    seed_durable_unknown_approval_effect(&data_dir, session_id, approval_id, &workspace_root)?;

    // When: the operator marks the unknown effect completed.
    let receipt = resolve_approval_effect_in_data_dir(
        DesktopApprovalEffectResolutionInput {
            session_id: session_id.to_owned(),
            approval_id: approval_id.to_owned(),
            outcome: DesktopApprovalEffectOutcome::Completed,
        },
        &data_dir,
    )?;
    let record = get_approval_effect_in_data_dir(
        crate::desktop_commands::DesktopApprovalEffectQueryInput {
            session_id: session_id.to_owned(),
            approval_id: approval_id.to_owned(),
        },
        &data_dir,
    )?;
    let second = resolve_approval_effect_in_data_dir(
        DesktopApprovalEffectResolutionInput {
            session_id: session_id.to_owned(),
            approval_id: approval_id.to_owned(),
            outcome: DesktopApprovalEffectOutcome::Failed,
        },
        &data_dir,
    )?;
    let log = read_session_events_from_data_dir(&data_dir, session_id)?;

    // Then: metadata resolves without tool replay; a conflicting second resolve is inert.
    assert_eq!(receipt.status, "resolved");
    let effect = receipt.effect.ok_or("missing resolved effect")?;
    assert_eq!(effect.state, "unknown");
    assert_eq!(
        effect.outcome,
        Some(DesktopApprovalEffectOutcome::Completed)
    );
    assert_eq!(
        record.as_ref().and_then(|value| value.outcome.clone()),
        Some(DesktopApprovalEffectOutcome::Completed)
    );
    assert_eq!(second.status, "idle");
    assert!(!event_types(&log).contains(&"tool.completed".to_owned()));
    assert!(!event_types(&log).contains(&"command.completed".to_owned()));
    assert!(!event_types(&log).contains(&"file.diff.applied".to_owned()));
    remove_dir_all(data_dir)?;
    remove_dir_all(workspace_root)?;
    Ok(())
}

#[test]
fn durable_unknown_effect_resolution_records_failed_without_tool_execution()
-> Result<(), Box<dyn Error>> {
    // Given: a separate durable unknown effect identity for the failed outcome.
    let data_dir = temp_data_dir("unknown-effect-failed")?;
    let workspace_root = temp_data_dir("unknown-effect-failed-workspace")?;
    create_dir_all(&workspace_root)?;
    let session_id = "session_unknown_effect_failed";
    let approval_id = "approval_permission_call_unknown_failed";
    seed_durable_unknown_approval_effect(&data_dir, session_id, approval_id, &workspace_root)?;

    // When: the operator marks the unknown effect failed.
    let receipt = resolve_approval_effect_in_data_dir(
        DesktopApprovalEffectResolutionInput {
            session_id: session_id.to_owned(),
            approval_id: approval_id.to_owned(),
            outcome: DesktopApprovalEffectOutcome::Failed,
        },
        &data_dir,
    )?;
    let second = resolve_approval_effect_in_data_dir(
        DesktopApprovalEffectResolutionInput {
            session_id: session_id.to_owned(),
            approval_id: approval_id.to_owned(),
            outcome: DesktopApprovalEffectOutcome::Completed,
        },
        &data_dir,
    )?;
    let log = read_session_events_from_data_dir(&data_dir, session_id)?;

    // Then: failed outcome is durable without tool execution or second-resolution overwrite.
    assert_eq!(receipt.status, "resolved");
    let effect = receipt.effect.ok_or("missing resolved effect")?;
    assert_eq!(effect.state, "unknown");
    assert_eq!(effect.outcome, Some(DesktopApprovalEffectOutcome::Failed));
    assert_eq!(second.status, "idle");
    assert!(!event_types(&log).contains(&"tool.completed".to_owned()));
    assert!(!event_types(&log).contains(&"tool.failed".to_owned()));
    assert!(!event_types(&log).contains(&"command.completed".to_owned()));
    remove_dir_all(data_dir)?;
    remove_dir_all(workspace_root)?;
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
