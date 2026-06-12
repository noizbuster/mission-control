use super::{SessionLogState, list_sessions_in_data_dir, read_session_snapshot_from_data_dir};
use serde_json::{Value, json};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn sessions_keep_jsonl_facts_when_index_is_stale() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("stale-index")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_stale_index.jsonl"),
        session_log(
            "session_stale_index",
            &[
                event_record(
                    "session_stale_index",
                    "event_started",
                    0,
                    "task.started",
                    "2026-06-09T00:00:00.000Z",
                ),
                event_record(
                    "session_stale_index",
                    "event_completed",
                    1,
                    "task.completed",
                    "2026-06-09T00:01:00.000Z",
                ),
            ],
        ),
    )?;
    write_session_index(
        &data_dir,
        "session_stale_index",
        1,
        "2099-01-01T00:00:00.000Z",
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let snapshot = read_session_snapshot_from_data_dir(&data_dir, "session_stale_index")?;

    assert_eq!(sessions.first().map(|session| session.event_count), Some(2));
    assert_eq!(
        sessions
            .first()
            .and_then(|session| session.updated_at.as_deref()),
        Some("2026-06-09T00:01:00.000Z")
    );
    assert_eq!(snapshot.event_count, 2);
    assert_eq!(to_value_bool(&snapshot, "indexed")?, Some(false));
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn sessions_do_not_use_index_timestamp_without_log_event_anchor() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("unanchored-index")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_header_only.jsonl"),
        session_log("session_header_only", &[]),
    )?;
    write_session_index_records(
        &data_dir,
        &[
            ("session_header_only", 0, "2099-01-01T00:00:00.000Z"),
            ("session_missing_leftover", 0, "2099-01-01T00:01:00.000Z"),
        ],
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let header_only = find_session(&sessions, "session_header_only")?;
    let missing = find_session(&sessions, "session_missing_leftover")?;
    let snapshot = read_session_snapshot_from_data_dir(&data_dir, "session_header_only")?;

    assert_eq!(header_only.updated_at, None);
    assert_eq!(to_value_bool(header_only, "indexed")?, Some(false));
    assert_eq!(missing.updated_at, None);
    assert_eq!(to_value_bool(missing, "indexed")?, Some(false));
    assert_eq!(snapshot.updated_at, None);
    assert_eq!(to_value_bool(&snapshot, "indexed")?, Some(false));
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn sessions_surface_corrupt_index_without_hiding_log_diagnostics() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("corrupt-index")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_valid.jsonl"),
        session_log(
            "session_valid",
            &[event_record(
                "session_valid",
                "event_valid",
                0,
                "task.completed",
                "2026-06-09T00:00:00.000Z",
            )],
        ),
    )?;
    write(
        data_dir.join("sessions").join("session_corrupt.jsonl"),
        session_log(
            "session_corrupt",
            &[
                r#"{"eventId":"event_bad","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_other","durability":"durable","event":{"type":"task.completed","timestamp":"2026-06-09T00:00:00.000Z","sessionId":"session_other","message":"wrong session"}}"#.to_owned(),
            ],
        ),
    )?;
    write(data_dir.join("session-index.json"), "{\"version\":\n")?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let valid = find_session(&sessions, "session_valid")?;
    let corrupt = find_session(&sessions, "session_corrupt")?;

    assert_eq!(valid.state, SessionLogState::Available);
    assert!(
        valid
            .diagnostics
            .iter()
            .any(|item| item.code == "corrupt_index")
    );
    assert_eq!(corrupt.state, SessionLogState::Corrupt);
    assert!(
        corrupt
            .diagnostics
            .iter()
            .any(|item| item.code == "corrupt_index")
    );
    assert!(
        corrupt
            .diagnostics
            .iter()
            .any(|item| item.code == "session_mismatch")
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn sessions_require_index_diagnostics_field() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("missing-index-diagnostics")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir
            .join("sessions")
            .join("session_missing_index_field.jsonl"),
        session_log(
            "session_missing_index_field",
            &[event_record(
                "session_missing_index_field",
                "event_valid",
                0,
                "task.completed",
                "2026-06-09T00:00:00.000Z",
            )],
        ),
    )?;
    write(
        data_dir.join("session-index.json"),
        r#"{"version":1,"records":[]}"#,
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let session = find_session(&sessions, "session_missing_index_field")?;

    assert_eq!(session.state, SessionLogState::Available);
    assert!(
        session
            .diagnostics
            .iter()
            .any(|item| item.code == "corrupt_index")
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

fn session_log(session_id: &str, event_records: &[String]) -> String {
    let mut output = format!(
        "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n",
        session_id,
    );
    for event_record in event_records {
        output.push_str(&format!(
            "{{\"kind\":\"mission-control.session-event\",\"version\":1,\"event\":{}}}\n",
            event_record,
        ));
    }
    output
}

fn event_record(
    session_id: &str,
    event_id: &str,
    sequence: usize,
    event_type: &str,
    timestamp: &str,
) -> String {
    format!(
        "{{\"eventId\":\"{}\",\"sequence\":{},\"createdAt\":\"{}\",\"sessionId\":\"{}\",\"durability\":\"durable\",\"event\":{{\"type\":\"{}\",\"timestamp\":\"{}\",\"sessionId\":\"{}\",\"message\":\"event\"}}}}",
        event_id, sequence, timestamp, session_id, event_type, timestamp, session_id,
    )
}

fn write_session_index(
    data_dir: &Path,
    session_id: &str,
    event_count: usize,
    updated_at: &str,
) -> Result<(), Box<dyn Error>> {
    write_session_index_records(data_dir, &[(session_id, event_count, updated_at)])
}

fn write_session_index_records(
    data_dir: &Path,
    records: &[(&str, usize, &str)],
) -> Result<(), Box<dyn Error>> {
    let index = json!({
        "version": 1,
        "records": records.iter().map(|(session_id, event_count, updated_at)| json!({
            "kind": "session",
            "sessionId": session_id,
            "status": "stopped",
            "startedAt": "2026-06-09T00:00:00.000Z",
            "eventCount": event_count,
            "updatedAt": updated_at,
            "sourceFilePath": data_dir
                .join("sessions")
                .join(format!("{session_id}.jsonl"))
                .to_string_lossy()
                .to_string(),
        })).collect::<Vec<_>>(),
        "diagnostics": [],
    });
    write(
        data_dir.join("session-index.json"),
        serde_json::to_string(&index)?,
    )?;
    Ok(())
}

fn find_session<'a>(
    sessions: &'a [super::DesktopSessionSummary],
    session_id: &str,
) -> Result<&'a super::DesktopSessionSummary, Box<dyn Error>> {
    sessions
        .iter()
        .find(|session| session.session_id == session_id)
        .ok_or_else(|| format!("expected {session_id} in session list").into())
}

fn to_value_bool<T: serde::Serialize>(
    value: &T,
    key: &str,
) -> Result<Option<bool>, Box<dyn Error>> {
    let value = serde_json::to_value(value)?;
    Ok(value.get(key).and_then(Value::as_bool))
}

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}
