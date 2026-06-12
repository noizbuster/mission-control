use crate::desktop_commands::{
    DesktopApprovalDecisionInput, DesktopPromptCommandInput, DesktopRunCommandInput,
    decide_approval_in_data_dir, interrupt_run_in_data_dir, queue_follow_up_in_data_dir,
    resume_run_in_data_dir, steer_run_in_data_dir, submit_prompt_in_data_dir,
    submit_prompt_with_bridge,
};
use crate::sessions::{SessionLogState, read_session_events_from_data_dir};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

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

#[test]
fn run_and_approval_commands_append_parseable_session_events() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("run-approval-bridge")?;
    let run = DesktopRunCommandInput {
        session_id: "session_bridge_run".to_owned(),
        reason: Some("manual stop".to_owned()),
    };
    let approval = DesktopApprovalDecisionInput {
        session_id: "session_bridge_run".to_owned(),
        approval_id: "approval_permission_call_patch".to_owned(),
        state: "denied".to_owned(),
        reason: Some("denied".to_owned()),
    };

    let queued = queue_follow_up_in_data_dir(prompt_input("session_bridge_run"), &data_dir)?;
    let resumed = resume_run_in_data_dir(run.clone(), &data_dir)?;
    let interrupted = interrupt_run_in_data_dir(run, &data_dir)?;
    seed_pending_file_patch_approval(
        &data_dir,
        "session_bridge_run",
        "approval_permission_call_patch",
        ".mission-control-denied.txt",
        "denied write",
    )?;
    let decided = decide_approval_in_data_dir(approval, &data_dir)?;
    let log = read_session_events_from_data_dir(&data_dir, "session_bridge_run")?;

    assert_eq!(queued.status, "queued");
    assert_eq!(resumed.status, "completed");
    assert_eq!(interrupted.status, "idle");
    assert_eq!(decided.status, "blocked");
    assert!(queued.events_written > 0);
    assert!(resumed.events_written > 0);
    assert!(interrupted.events_written > 0);
    assert!(decided.events_written > 0);
    assert_eq!(log.state, SessionLogState::Available);
    assert!(run_commands(&log).contains(&"resume".to_owned()));
    assert!(run_commands(&log).contains(&"interrupt".to_owned()));
    assert!(event_types(&log).contains(&"approval.updated".to_owned()));
    assert!(event_types(&log).contains(&"approval.blocked".to_owned()));
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

fn seed_pending_file_patch_approval(
    data_dir: &std::path::Path,
    session_id: &str,
    approval_id: &str,
    file_path: &str,
    content: &str,
) -> Result<(), Box<dyn Error>> {
    create_dir_all(data_dir.join("sessions"))?;
    let path = data_dir
        .join("sessions")
        .join(format!("{session_id}.jsonl"));
    if !path.exists() {
        std::fs::write(
            &path,
            format!(
                "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{session_id}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n"
            ),
        )?;
    }
    let contents = std::fs::read_to_string(&path)?;
    let sequence = contents.lines().count().saturating_sub(1);
    let request_id = approval_id
        .strip_prefix("approval_")
        .map_or_else(|| approval_id.to_owned(), str::to_owned);
    let tool_call_id = request_id
        .strip_prefix("permission_")
        .map_or_else(|| request_id.clone(), str::to_owned);
    let patch = [
        format!("diff --git a/{file_path} b/{file_path}"),
        "--- /dev/null".to_owned(),
        format!("+++ b/{file_path}"),
        "@@ -0,0 +1 @@".to_owned(),
        format!("+{content}"),
        String::new(),
    ]
    .join("\n");
    let arguments_json = serde_json::to_string(&serde_json::json!({ "patch": patch }))?;
    let tool_call = serde_json::json!({
        "kind": "mission-control.session-event",
        "version": 1,
        "event": {
            "eventId": format!("seed_tool_call_{sequence}"),
            "sequence": sequence,
            "createdAt": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "durability": "durable",
            "event": {
                "type": "task.progress",
                "timestamp": "2026-06-09T00:00:00.000Z",
                "sessionId": session_id,
                "message": "tool call completed: file.patch",
                "nativeSidecarStatus": "mock",
                "modelProviderSelection": {
                    "providerID": "mock",
                    "modelID": "mission-control-demo"
                },
                "providerStreamChunk": {
                    "kind": "tool_call_completed",
                    "requestId": "request_seed",
                    "sequence": 1,
                    "toolCall": {
                        "toolCallId": tool_call_id,
                        "toolName": "file.patch",
                        "argumentsJson": arguments_json
                    }
                }
            }
        }
    });
    let record = serde_json::json!({
        "kind": "mission-control.session-event",
        "version": 1,
        "event": {
            "eventId": format!("seed_approval_{}", sequence + 1),
            "sequence": sequence + 1,
            "createdAt": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "durability": "durable",
            "event": {
                "type": "approval.requested",
                "timestamp": "2026-06-09T00:00:00.000Z",
                "sessionId": session_id,
                "message": "approval requested: file.patch",
                "nativeSidecarStatus": "mock",
                "modelProviderSelection": {
                    "providerID": "mock",
                    "modelID": "mission-control-demo"
                },
                "approvalRecord": {
                    "approvalId": approval_id,
                    "requestId": request_id,
                    "policyDecision": "requires_approval",
                    "state": "pending",
                    "subject": {
                        "kind": "tool",
                        "id": "file.patch"
                    },
                    "requestedAt": "2026-06-09T00:00:00.000Z",
                    "reason": "approve file.patch"
                }
            }
        }
    });
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)?
        .write_all(format!("{tool_call}\n{record}\n").as_bytes())?;
    Ok(())
}

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}
