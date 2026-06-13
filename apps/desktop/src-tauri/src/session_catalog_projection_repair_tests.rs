use crate::session_catalog::{list_sessions_in_data_dir, read_session_snapshot_from_data_dir};
use serde_json::{Value, to_value};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn session_catalog_counts_only_currently_blocked_runs() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("session-catalog-active-blocked-count")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_active_blocked.jsonl"),
        session_log_with_resumed_run("session_active_blocked"),
    )?;

    let snapshot = read_session_snapshot_from_data_dir(&data_dir, "session_active_blocked")?;
    let snapshot_value = to_value(snapshot)?;

    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("blockedRunCount"))
            .and_then(Value::as_u64),
        Some(0)
    );

    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn session_catalog_ignores_schema_invalid_projection_payloads() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("session-catalog-invalid-projection-payloads")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_invalid_projection.jsonl"),
        session_log_with_invalid_projection_payloads("session_invalid_projection"),
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let summary = sessions
        .iter()
        .find(|session| session.session_id == "session_invalid_projection")
        .ok_or("missing session_invalid_projection summary")?;
    let snapshot = read_session_snapshot_from_data_dir(&data_dir, "session_invalid_projection")?;
    let summary_value = to_value(summary)?;
    let snapshot_value = to_value(snapshot)?;

    assert_eq!(summary_value.get("sessionTree"), None);
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("pendingApprovalCount"))
            .and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("blockedRunCount"))
            .and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("commandEventCount"))
            .and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("diffEventCount"))
            .and_then(Value::as_u64),
        Some(0)
    );

    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn session_catalog_ignores_shape_valid_projection_payloads_on_wrong_event_types() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("session-catalog-wrong-type-projection-payloads")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir
            .join("sessions")
            .join("session_wrong_type_projection.jsonl"),
        session_log_with_wrong_type_projection_payloads("session_wrong_type_projection"),
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let summary = sessions
        .iter()
        .find(|session| session.session_id == "session_wrong_type_projection")
        .ok_or("missing session_wrong_type_projection summary")?;
    let snapshot = read_session_snapshot_from_data_dir(&data_dir, "session_wrong_type_projection")?;
    let summary_value = to_value(summary)?;
    let snapshot_value = to_value(snapshot)?;

    assert_eq!(summary_value.get("sessionTree"), None);
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("pendingApprovalCount"))
            .and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("blockedRunCount"))
            .and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("commandEventCount"))
            .and_then(Value::as_u64),
        Some(0)
    );
    assert_eq!(
        snapshot_value
            .get("stats")
            .and_then(|value| value.get("diffEventCount"))
            .and_then(Value::as_u64),
        Some(0)
    );

    remove_dir_all(data_dir)?;
    Ok(())
}

fn session_log_with_resumed_run(session_id: &str) -> String {
    let records = [
        session_event(
            session_id,
            0,
            r#"{"type":"run.started","timestamp":"2026-06-13T00:00:00.000Z","sessionId":"session_active_blocked","message":"run started","run":{"command":"run","state":"running","runId":"run_1"}}"#,
        ),
        session_event(
            session_id,
            1,
            r#"{"type":"run.blocked","timestamp":"2026-06-13T00:00:01.000Z","sessionId":"session_active_blocked","message":"waiting for approval: file.patch","run":{"command":"run","state":"blocked_on_approval","runId":"run_1","toolCallId":"call_patch","reason":"waiting for approval: file.patch"}}"#,
        ),
        session_event(
            session_id,
            2,
            r#"{"type":"run.started","timestamp":"2026-06-13T00:00:02.000Z","sessionId":"session_active_blocked","message":"run resumed","run":{"command":"resume","state":"running","runId":"run_1"}}"#,
        ),
        session_event(
            session_id,
            3,
            r#"{"type":"run.completed","timestamp":"2026-06-13T00:00:03.000Z","sessionId":"session_active_blocked","message":"run completed","run":{"command":"resume","state":"completed","runId":"run_1"}}"#,
        ),
    ];

    log_with_records(session_id, &records)
}

fn session_log_with_invalid_projection_payloads(session_id: &str) -> String {
    let records = [
        session_event(
            session_id,
            0,
            r#"{"type":"session.metadata.updated","timestamp":"2026-06-13T00:00:00.000Z","sessionId":"session_invalid_projection","message":"invalid metadata","sessionTree":{"kind":"metadata","name":"Broken session","cwd":42,"trustedRoot":"/workspace/mission-control","workspaceTrust":"trusted"}}"#,
        ),
        session_event(
            session_id,
            1,
            r#"{"type":"approval.requested","timestamp":"2026-06-13T00:00:01.000Z","sessionId":"session_invalid_projection","message":"approval requested","approvalRecord":{"approvalId":"approval_permission_call_patch","requestId":"permission_call_patch","policyDecision":"requires_approval","state":7,"subject":{"kind":"tool","id":"file.patch"},"requestedAt":"2026-06-13T00:00:01.000Z"}}"#,
        ),
        session_event(
            session_id,
            2,
            r#"{"type":"run.blocked","timestamp":"2026-06-13T00:00:02.000Z","sessionId":"session_invalid_projection","message":"waiting for approval","run":{"command":"run","state":"blocked_on_approval","runId":7,"toolCallId":"call_patch","reason":"waiting for approval"}}"#,
        ),
        session_event(
            session_id,
            3,
            r#"{"type":"command.completed","timestamp":"2026-06-13T00:00:03.000Z","sessionId":"session_invalid_projection","message":"command completed","command":{"command":"pnpm","cwd":42,"status":"completed","exitCode":0}}"#,
        ),
        session_event(
            session_id,
            4,
            r#"{"type":"file.diff.proposed","timestamp":"2026-06-13T00:00:04.000Z","sessionId":"session_invalid_projection","message":"diff proposed","diffFiles":[{"filePath":7,"changeKind":"modified","hunks":[]}]}"#,
        ),
    ];

    log_with_records(session_id, &records)
}

fn session_log_with_wrong_type_projection_payloads(session_id: &str) -> String {
    let records = [
        session_event(
            session_id,
            0,
            r#"{"type":"task.progress","timestamp":"2026-06-13T00:00:00.000Z","sessionId":"session_wrong_type_projection","message":"forged metadata","sessionTree":{"kind":"metadata","name":"Forged session","cwd":"/workspace/forged","trustedRoot":"/workspace/forged","workspaceTrust":"trusted","parentSessionId":"session_parent"}}"#,
        ),
        session_event(
            session_id,
            1,
            r#"{"type":"task.progress","timestamp":"2026-06-13T00:00:01.000Z","sessionId":"session_wrong_type_projection","message":"forged approval","approvalRecord":{"approvalId":"approval_permission_call_patch","requestId":"permission_call_patch","policyDecision":"requires_approval","state":"pending","subject":{"kind":"tool","id":"file.patch"},"requestedAt":"2026-06-13T00:00:01.000Z"}}"#,
        ),
        session_event(
            session_id,
            2,
            r#"{"type":"log","timestamp":"2026-06-13T00:00:02.000Z","sessionId":"session_wrong_type_projection","message":"forged blocked run","run":{"command":"run","state":"blocked_on_approval","runId":"run_forged","toolCallId":"call_patch","reason":"waiting for approval"}}"#,
        ),
        session_event(
            session_id,
            3,
            r#"{"type":"task.progress","timestamp":"2026-06-13T00:00:03.000Z","sessionId":"session_wrong_type_projection","message":"forged command","command":{"command":["pnpm","test"],"cwd":"/workspace/forged","status":"completed","exitCode":0}}"#,
        ),
        session_event(
            session_id,
            4,
            r#"{"type":"task.progress","timestamp":"2026-06-13T00:00:04.000Z","sessionId":"session_wrong_type_projection","message":"forged diff","diffFiles":[{"filePath":"src/forged.ts","changeKind":"modified","hunks":[]}]}"#,
        ),
    ];

    log_with_records(session_id, &records)
}

fn log_with_records(session_id: &str, records: &[String]) -> String {
    let mut output = format!(
        "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{session_id}\",\"createdAt\":\"2026-06-13T00:00:00.000Z\"}}\n"
    );
    for record in records {
        output.push_str(record);
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
