use crate::desktop_commands::{DesktopApprovalDecisionInput, decide_approval_with_bridge};
use crate::sessions::{SessionLogState, read_session_events_from_data_dir};
use std::error::Error;
use std::fs::{create_dir_all, read_to_string, remove_dir_all};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
    assert!(event_types(&log).contains(&"file.diff.applied".to_owned()));
    assert!(event_types(&log).contains(&"tool.completed".to_owned()));
    assert!(event_types(&log).contains(&"run.completed".to_owned()));
    remove_dir_all(data_dir)?;
    remove_dir_all(workspace_root)?;
    Ok(())
}

#[test]
fn approved_command_run_persists_command_settlement_through_core_bridge()
-> Result<(), Box<dyn Error>> {
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
    assert!(event_types(&log).contains(&"command.completed".to_owned()));
    assert!(event_types(&log).contains(&"tool.completed".to_owned()));
    assert!(event_types(&log).contains(&"run.completed".to_owned()));
    remove_dir_all(data_dir)?;
    Ok(())
}

fn seed_pending_file_patch_approval(
    data_dir: &Path,
    session_id: &str,
    approval_id: &str,
    file_path: &str,
    content: &str,
) -> Result<(), Box<dyn Error>> {
    create_dir_all(data_dir.join("sessions"))?;
    let path = data_dir
        .join("sessions")
        .join(format!("{session_id}.jsonl"));
    std::fs::write(
        &path,
        format!(
            "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{session_id}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n"
        ),
    )?;
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
    let tool_call = seeded_tool_call(session_id, &tool_call_id, "file.patch", &arguments_json);
    let approval = seeded_approval(session_id, approval_id, &request_id, "file.patch");
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)?
        .write_all(format!("{tool_call}\n{approval}\n").as_bytes())?;
    Ok(())
}

fn seed_pending_command_approval(
    data_dir: &Path,
    session_id: &str,
    approval_id: &str,
) -> Result<(), Box<dyn Error>> {
    create_dir_all(data_dir.join("sessions"))?;
    let path = data_dir
        .join("sessions")
        .join(format!("{session_id}.jsonl"));
    std::fs::write(
        &path,
        format!(
            "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{session_id}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n"
        ),
    )?;
    let request_id = approval_id
        .strip_prefix("approval_")
        .map_or_else(|| approval_id.to_owned(), str::to_owned);
    let tool_call_id = request_id
        .strip_prefix("permission_")
        .map_or_else(|| request_id.clone(), str::to_owned);
    let arguments_json = serde_json::to_string(&serde_json::json!({
        "command": "node",
        "args": ["--eval", "console.log('mission-control command.run harness ok')"]
    }))?;
    let tool_call = seeded_tool_call(session_id, &tool_call_id, "command.run", &arguments_json);
    let approval = seeded_approval(session_id, approval_id, &request_id, "command.run");
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)?
        .write_all(format!("{tool_call}\n{approval}\n").as_bytes())?;
    Ok(())
}

fn seeded_tool_call(
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    arguments_json: &str,
) -> serde_json::Value {
    serde_json::json!({
        "kind": "mission-control.session-event",
        "version": 1,
        "event": {
            "eventId": "seed_tool_call_0",
            "sequence": 0,
            "createdAt": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "durability": "durable",
            "event": {
                "type": "task.progress",
                "timestamp": "2026-06-09T00:00:00.000Z",
                "sessionId": session_id,
                "message": format!("tool call completed: {tool_name}"),
                "nativeSidecarStatus": "mock",
                "modelProviderSelection": { "providerID": "local", "modelID": "local-echo" },
                "providerStreamChunk": {
                    "kind": "tool_call_completed",
                    "requestId": "request_seed",
                    "sequence": 1,
                    "toolCall": {
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "argumentsJson": arguments_json
                    }
                }
            }
        }
    })
}

fn seeded_approval(
    session_id: &str,
    approval_id: &str,
    request_id: &str,
    tool_name: &str,
) -> serde_json::Value {
    serde_json::json!({
        "kind": "mission-control.session-event",
        "version": 1,
        "event": {
            "eventId": "seed_approval_1",
            "sequence": 1,
            "createdAt": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "durability": "durable",
            "event": {
                "type": "approval.requested",
                "timestamp": "2026-06-09T00:00:00.000Z",
                "sessionId": session_id,
                "message": format!("approval requested: {tool_name}"),
                "nativeSidecarStatus": "mock",
                "modelProviderSelection": { "providerID": "local", "modelID": "local-echo" },
                "approvalRecord": {
                    "approvalId": approval_id,
                    "requestId": request_id,
                    "policyDecision": "requires_approval",
                    "state": "pending",
                    "subject": { "kind": "tool", "id": tool_name },
                    "requestedAt": "2026-06-09T00:00:00.000Z",
                    "reason": format!("approve {tool_name}")
                }
            }
        }
    })
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

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
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
