use crate::desktop_command_test_support::{
    seed_imported_jsonl_pending_file_patch_approval, temp_data_dir,
};
use crate::desktop_commands::{
    DesktopApprovalDecisionInput, DesktopPromptCommandInput, DesktopRunCommandInput,
    decide_approval_with_bridge, interrupt_run_in_data_dir, queue_follow_up_in_data_dir,
    read_session_events_from_data_dir, resolve_approval_effect_in_data_dir, resume_run_in_data_dir,
    steer_run_in_data_dir, submit_prompt_in_data_dir, submit_prompt_with_bridge,
};
use crate::sessions::SessionLogState;
use std::error::Error;
use std::fs::remove_dir_all;

#[test]
fn prompt_commands_call_core_service_and_append_parseable_session_events()
-> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("command-bridge")?;
    let prompt = prompt_input("session_bridge_prompt");

    let submit = submit_prompt_in_data_dir(prompt.clone(), &data_dir)?;
    let queued = queue_follow_up_in_data_dir(prompt.clone(), &data_dir)?;
    let steered = steer_run_in_data_dir(prompt, &data_dir)?;
    let log = read_session_events_from_data_dir(&data_dir, "session_bridge_prompt")?;

    assert_eq!(submit.status, "completed");
    assert_eq!(queued.status, "queued");
    assert_eq!(steered.status, "completed");
    assert!(submit.events_written > 0);
    assert!(queued.events_written > 0);
    assert!(steered.events_written > 0);
    assert_eq!(log.state, SessionLogState::Available);
    assert!(event_types(&log).contains(&"prompt.admitted".to_owned()));
    assert!(event_types(&log).contains(&"model.call.completed".to_owned()));
    assert!(event_types(&log).contains(&"run.completed".to_owned()));
    remove_dir_all(data_dir)?;
    Ok(())
}

// FIXME(2026-08-15): stale fixture premise — the SQLite-native session
// transition removed legacy-JSONL reads (readLocalSessionReplay consults only
// `hasSqliteSession`), so the seeded `sessions/*.jsonl` approval session now
// reads back as Missing and this fails at the approval_log assertion. The
// test verifies imported-approval inertness (import-safe authority, 7b4a7109);
// reviving it needs a seed through the canonical DB that still counts as
// *imported* authority — a desktop-owner design call, not a mechanical port.
#[test]
#[ignore = "legacy-JSONL approval seed no longer readable after SQLite-native sessions; needs a DB-side imported-authority seed"]
fn run_commands_append_events_and_imported_approval_stays_inert() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("run-approval-bridge")?;
    let run_session_id = "session_bridge_run";
    let approval_session_id = "session_bridge_approval";
    let run = DesktopRunCommandInput {
        session_id: run_session_id.to_owned(),
        reason: Some("manual stop".to_owned()),
    };
    let approval = DesktopApprovalDecisionInput {
        session_id: approval_session_id.to_owned(),
        approval_id: "approval_permission_call_patch".to_owned(),
        state: "denied".to_owned(),
        reason: Some("denied".to_owned()),
    };

    let queued = queue_follow_up_in_data_dir(prompt_input(run_session_id), &data_dir)?;
    let resumed = resume_run_in_data_dir(run.clone(), &data_dir)?;
    let interrupted = interrupt_run_in_data_dir(run, &data_dir)?;
    seed_imported_jsonl_pending_file_patch_approval(
        &data_dir,
        approval_session_id,
        "approval_permission_call_patch",
        ".mission-control-denied.txt",
        "denied write",
    )?;
    let bridge = crate::desktop_command_bridge::DesktopCommandBridge::with_workspace_root(
        std::env::current_dir()?,
    )?;
    let decided = decide_approval_with_bridge(approval, &data_dir, &bridge)?;
    let run_log = read_session_events_from_data_dir(&data_dir, run_session_id)?;
    let approval_log = read_session_events_from_data_dir(&data_dir, approval_session_id)?;

    assert_eq!(queued.status, "queued");
    assert_eq!(resumed.status, "completed");
    assert_eq!(interrupted.status, "idle");
    assert_eq!(decided.status, "idle");
    assert!(queued.events_written > 0);
    assert!(resumed.events_written > 0);
    assert!(interrupted.events_written > 0);
    assert_eq!(decided.events_written, 0);
    assert_eq!(run_log.state, SessionLogState::Available);
    assert_eq!(approval_log.state, SessionLogState::Available);
    assert!(run_commands(&run_log).contains(&"resume".to_owned()));
    assert!(run_commands(&run_log).contains(&"interrupt".to_owned()));
    assert!(!event_types(&approval_log).contains(&"approval.updated".to_owned()));
    assert!(!event_types(&approval_log).contains(&"approval.blocked".to_owned()));
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn command_returns_failed_when_bridge_is_unavailable() -> Result<(), Box<dyn Error>> {
    let data_file = temp_data_dir("unavailable-bridge")?;
    let missing_script = data_file.join("missing-service.mjs");
    let bridge =
        crate::desktop_command_bridge::DesktopCommandBridge::with_script_path(missing_script)?;

    let receipt = submit_prompt_with_bridge(
        prompt_input("session_bridge_unavailable"),
        &data_file,
        &bridge,
    )?;

    assert_eq!(receipt.status, "failed");
    assert_eq!(receipt.events_written, 0);
    assert!(!data_file.exists());
    Ok(())
}

#[test]
fn unknown_effect_resolution_reaches_the_core_bridge_without_a_tool_execution_receipt()
-> Result<(), Box<dyn Error>> {
    // Given: no executable tool action is requested, only an operator outcome for an unknown effect.
    let data_dir = temp_data_dir("effect-resolution-bridge")?;
    let input = crate::desktop_commands::DesktopApprovalEffectResolutionInput {
        session_id: "session_effect".to_owned(),
        approval_id: "approval_effect".to_owned(),
        outcome: crate::desktop_commands::DesktopApprovalEffectOutcome::Failed,
    };

    // When: the Tauri command bridge dispatches the resolution to core.
    let receipt = resolve_approval_effect_in_data_dir(input, &data_dir)?;

    // Then: an absent effect is reported as idle rather than invoking an approval decision or tool run.
    assert_eq!(receipt.session_id, "session_effect");
    assert_eq!(receipt.status, "idle");
    assert!(receipt.effect.is_none());
    remove_dir_all(data_dir)?;
    Ok(())
}

fn prompt_input(session_id: &str) -> DesktopPromptCommandInput {
    DesktopPromptCommandInput {
        session_id: session_id.to_owned(),
        prompt: "desktop prompt".to_owned(),
        model_provider_selection: None,
        parent_message_id: None,
        resume: None,
    }
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

fn run_commands(log: &crate::sessions::DesktopSessionLog) -> Vec<String> {
    log.envelopes
        .iter()
        .filter_map(|envelope| {
            envelope
                .get("event")
                .and_then(|event| event.get("run"))
                .and_then(|run| run.get("command"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}
