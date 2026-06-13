use crate::session_catalog::{list_sessions_in_data_dir, read_session_snapshot_from_data_dir};
use serde_json::{Value, to_value};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn session_catalog_projects_session_tree_and_stats_metadata() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("session-catalog-projection")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_projection.jsonl"),
        session_log_with_projection("session_projection"),
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let summary = sessions
        .iter()
        .find(|session| session.session_id == "session_projection")
        .ok_or("missing session_projection summary")?;
    let snapshot = read_session_snapshot_from_data_dir(&data_dir, "session_projection")?;
    let summary_value = to_value(summary)?;
    let snapshot_value = to_value(snapshot)?;

    assert_eq!(
        summary_value
            .get("sessionTree")
            .and_then(|value| value.get("workspaceTrust"))
            .and_then(Value::as_str),
        Some("trusted")
    );
    assert_eq!(
        summary_value
            .get("sessionTree")
            .and_then(|value| value.get("activeLeafId"))
            .and_then(Value::as_str),
        Some("entry_active")
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("pendingApprovalCount"))
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("blockedRunCount"))
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("commandEventCount"))
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("diffEventCount"))
            .and_then(Value::as_u64),
        Some(1)
    );

    remove_dir_all(data_dir)?;
    Ok(())
}

fn session_log_with_projection(session_id: &str) -> String {
    let records = [
        session_event(
            session_id,
            0,
            r#"{"type":"session.metadata.updated","timestamp":"2026-06-13T00:00:00.000Z","sessionId":"session_projection","message":"session metadata updated","sessionTree":{"kind":"metadata","name":"Coding parity session","cwd":"/workspace/mission-control","trustedRoot":"/workspace/mission-control","workspaceTrust":"trusted","parentSessionId":"session_parent"}}"#,
        ),
        session_event(
            session_id,
            1,
            r#"{"type":"session.tree.entry","timestamp":"2026-06-13T00:00:01.000Z","sessionId":"session_projection","message":"root entry","sessionTree":{"kind":"entry","entryId":"entry_root","active":false}}"#,
        ),
        session_event(
            session_id,
            2,
            r#"{"type":"session.tree.entry","timestamp":"2026-06-13T00:00:02.000Z","sessionId":"session_projection","message":"active entry","sessionTree":{"kind":"entry","entryId":"entry_active","parentEntryId":"entry_root","active":true}}"#,
        ),
        session_event(
            session_id,
            3,
            r#"{"type":"run.blocked","timestamp":"2026-06-13T00:00:03.000Z","sessionId":"session_projection","message":"waiting for approval: file.patch","run":{"command":"run","state":"blocked_on_approval","runId":"run_blocked","toolCallId":"call_patch","reason":"waiting for approval: file.patch"}}"#,
        ),
        session_event(
            session_id,
            4,
            r#"{"type":"approval.requested","timestamp":"2026-06-13T00:00:04.000Z","sessionId":"session_projection","message":"approval requested","approvalRecord":{"approvalId":"approval_permission_call_patch","requestId":"permission_call_patch","policyDecision":"requires_approval","state":"pending","subject":{"kind":"tool","id":"file.patch"},"requestedAt":"2026-06-13T00:00:04.000Z"}}"#,
        ),
        session_event(
            session_id,
            5,
            r#"{"type":"file.diff.proposed","timestamp":"2026-06-13T00:00:05.000Z","sessionId":"session_projection","message":"diff proposed","diffFiles":[{"filePath":"src/agent.ts","changeKind":"modified","hunks":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":[{"kind":"added","content":"updated content"}]}]}]}"#,
        ),
        session_event(
            session_id,
            6,
            r#"{"type":"command.completed","timestamp":"2026-06-13T00:00:06.000Z","sessionId":"session_projection","message":"command completed","command":{"command":["pnpm","test"],"cwd":"/workspace/mission-control","status":"completed","exitCode":0}}"#,
        ),
    ];

    let mut output = format!(
        "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{session_id}\",\"createdAt\":\"2026-06-13T00:00:00.000Z\"}}\n"
    );
    for record in records {
        output.push_str(&record);
        output.push('\n');
    }
    output
}

fn session_event(session_id: &str, sequence: usize, event_json: &str) -> String {
    format!(
        "{{\"kind\":\"mission-control.session-event\",\"version\":1,\"event\":{{\"eventId\":\"event_{sequence}\",\"sequence\":{sequence},\"createdAt\":\"2026-06-13T00:00:0{sequence}.000Z\",\"sessionId\":\"{session_id}\",\"durability\":\"durable\",\"event\":{event_json}}}}}"
    )
}

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!(
        "mission-control-desktop-{label}-{nanos}"
    )))
}
