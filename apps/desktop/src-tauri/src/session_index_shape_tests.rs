use super::{DesktopSessionSummary, list_sessions_in_data_dir};
use serde_json::{Value, json};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn sessions_reject_truncated_index_session_records() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("truncated-index-record")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir
            .join("sessions")
            .join("session_truncated_index.jsonl"),
        session_log(
            "session_truncated_index",
            &event_record("session_truncated_index"),
        ),
    )?;
    write(
        data_dir.join("session-index.json"),
        serde_json::to_string(&json!({
            "version": 1,
            "records": [{
                "kind": "session",
                "sessionId": "session_truncated_index",
                "eventCount": 1,
                "updatedAt": "2099-01-01T00:00:00.000Z"
            }],
            "diagnostics": []
        }))?,
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let session = find_session(&sessions, "session_truncated_index")?;

    assert_eq!(to_value_bool(session, "indexed")?, Some(false));
    assert!(
        session
            .diagnostics
            .iter()
            .any(|item| item.code == "corrupt_index")
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

fn session_log(session_id: &str, event_record: &str) -> String {
    format!(
        "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n\
         {{\"kind\":\"mission-control.session-event\",\"version\":1,\"event\":{}}}\n",
        session_id, event_record,
    )
}

fn event_record(session_id: &str) -> String {
    format!(
        "{{\"eventId\":\"event_valid\",\"sequence\":0,\"createdAt\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"durability\":\"durable\",\"event\":{{\"type\":\"task.completed\",\"timestamp\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"message\":\"event\"}}}}",
        session_id, session_id,
    )
}

fn find_session<'a>(
    sessions: &'a [DesktopSessionSummary],
    session_id: &str,
) -> Result<&'a DesktopSessionSummary, Box<dyn Error>> {
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
