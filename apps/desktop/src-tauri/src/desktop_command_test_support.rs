use std::error::Error;
use std::fs::{create_dir_all, write};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn seed_pending_file_patch_approval(
    data_dir: &Path,
    session_id: &str,
    approval_id: &str,
    file_path: &str,
    content: &str,
) -> Result<(), Box<dyn Error>> {
    create_dir_all(data_dir.join("sessions"))?;
    let path = data_dir.join("sessions").join(format!("{session_id}.jsonl"));
    if !path.exists() {
        write(
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
    let tool_call = event_record(
        session_id,
        format!("seed_tool_call_{sequence}"),
        sequence,
        serde_json::json!({
            "type": "task.progress",
            "timestamp": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "message": "tool call completed: file.patch",
            "nativeSidecarStatus": "mock",
            "modelProviderSelection": { "providerID": "mock", "modelID": "mission-control-demo" },
            "providerStreamChunk": {
                "kind": "tool_call_completed",
                "requestId": "request_seed",
                "sequence": 1,
                "toolCall": { "toolCallId": tool_call_id, "toolName": "file.patch", "argumentsJson": arguments_json }
            }
        }),
    );
    let permission_requested = event_record(
        session_id,
        format!("seed_permission_{}", sequence + 1),
        sequence + 1,
        serde_json::json!({
            "type": "permission.requested",
            "timestamp": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "message": "permission requested: file.patch",
            "nativeSidecarStatus": "mock",
            "modelProviderSelection": { "providerID": "mock", "modelID": "mission-control-demo" },
            "permissionRequest": {
                "id": request_id,
                "action": "file.patch",
                "reason": "approve file.patch"
            },
            "permissionDecision": {
                "requestId": request_id,
                "status": "requires_approval",
                "reason": "approve file.patch"
            }
        }),
    );
    let approval_requested = event_record(
        session_id,
        format!("seed_approval_{}", sequence + 2),
        sequence + 2,
        serde_json::json!({
            "type": "approval.requested",
            "timestamp": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "message": "approval requested: file.patch",
            "nativeSidecarStatus": "mock",
            "modelProviderSelection": { "providerID": "mock", "modelID": "mission-control-demo" },
            "approvalRecord": {
                "approvalId": approval_id,
                "requestId": request_id,
                "policyDecision": "requires_approval",
                "state": "pending",
                "subject": { "kind": "tool", "id": "file.patch" },
                "requestedAt": "2026-06-09T00:00:00.000Z",
                "reason": "approve file.patch"
            }
        }),
    );
    let run_blocked = event_record(
        session_id,
        format!("seed_run_blocked_{}", sequence + 3),
        sequence + 3,
        serde_json::json!({
            "type": "run.blocked",
            "timestamp": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "message": "waiting for approval: file.patch",
            "nativeSidecarStatus": "mock",
            "modelProviderSelection": { "providerID": "mock", "modelID": "mission-control-demo" },
            "run": {
                "command": "run",
                "state": "blocked_on_approval",
                "runId": "run_seed",
                "toolCallId": tool_call_id,
                "reason": "waiting for approval: file.patch"
            }
        }),
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)?
        .write_all(
            format!("{tool_call}\n{permission_requested}\n{approval_requested}\n{run_blocked}\n").as_bytes(),
        )?;
    Ok(())
}

pub(crate) fn seed_pending_command_approval(
    data_dir: &Path,
    session_id: &str,
    approval_id: &str,
) -> Result<(), Box<dyn Error>> {
    create_dir_all(data_dir.join("sessions"))?;
    let path = data_dir.join("sessions").join(format!("{session_id}.jsonl"));
    if !path.exists() {
        write(
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
    let arguments_json = serde_json::to_string(&serde_json::json!({
        "command": "node",
        "args": ["--eval", "console.log('mission-control command.run harness ok')"]
    }))?;
    let tool_call = event_record(
        session_id,
        format!("seed_command_tool_call_{sequence}"),
        sequence,
        serde_json::json!({
            "type": "task.progress",
            "timestamp": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "message": "tool call completed: command.run",
            "nativeSidecarStatus": "mock",
            "modelProviderSelection": { "providerID": "mock", "modelID": "mission-control-demo" },
            "providerStreamChunk": {
                "kind": "tool_call_completed",
                "requestId": "request_seed",
                "sequence": 1,
                "toolCall": { "toolCallId": tool_call_id, "toolName": "command.run", "argumentsJson": arguments_json }
            }
        }),
    );
    let permission_requested = event_record(
        session_id,
        format!("seed_command_permission_{}", sequence + 1),
        sequence + 1,
        serde_json::json!({
            "type": "permission.requested",
            "timestamp": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "message": "permission requested: command.run",
            "nativeSidecarStatus": "mock",
            "modelProviderSelection": { "providerID": "mock", "modelID": "mission-control-demo" },
            "permissionRequest": {
                "id": request_id,
                "action": "command.run",
                "reason": "approve command.run"
            },
            "permissionDecision": {
                "requestId": request_id,
                "status": "requires_approval",
                "reason": "approve command.run"
            }
        }),
    );
    let approval_requested = event_record(
        session_id,
        format!("seed_command_approval_{}", sequence + 2),
        sequence + 2,
        serde_json::json!({
            "type": "approval.requested",
            "timestamp": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "message": "approval requested: command.run",
            "nativeSidecarStatus": "mock",
            "modelProviderSelection": { "providerID": "mock", "modelID": "mission-control-demo" },
            "approvalRecord": {
                "approvalId": approval_id,
                "requestId": request_id,
                "policyDecision": "requires_approval",
                "state": "pending",
                "subject": { "kind": "tool", "id": "command.run" },
                "requestedAt": "2026-06-09T00:00:00.000Z",
                "reason": "approve command.run"
            }
        }),
    );
    let run_blocked = event_record(
        session_id,
        format!("seed_command_run_blocked_{}", sequence + 3),
        sequence + 3,
        serde_json::json!({
            "type": "run.blocked",
            "timestamp": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "message": "waiting for approval: command.run",
            "nativeSidecarStatus": "mock",
            "modelProviderSelection": { "providerID": "mock", "modelID": "mission-control-demo" },
            "run": {
                "command": "run",
                "state": "blocked_on_approval",
                "runId": "run_seed",
                "toolCallId": tool_call_id,
                "reason": "waiting for approval: command.run"
            }
        }),
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)?
        .write_all(
            format!("{tool_call}\n{permission_requested}\n{approval_requested}\n{run_blocked}\n").as_bytes(),
        )?;
    Ok(())
}

pub(crate) fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}

fn event_record(session_id: &str, event_id: String, sequence: usize, event: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "kind": "mission-control.session-event",
        "version": 1,
        "event": {
            "eventId": event_id,
            "sequence": sequence,
            "createdAt": "2026-06-09T00:00:00.000Z",
            "sessionId": session_id,
            "durability": "durable",
            "event": event
        }
    })
}
