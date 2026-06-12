use super::{SessionLogState, list_sessions_in_data_dir, read_session_events_from_data_dir};
use serde_json::{Value, json, to_value};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn sessions_use_index_order_and_lock_state() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("indexed-list")?;
    let sessions_dir = data_dir.join("sessions");
    create_dir_all(&sessions_dir)?;
    write(
        sessions_dir.join("session_a_old.jsonl"),
        completed_session_log("session_a_old", "event_old", "old"),
    )?;
    write(
        sessions_dir.join("session_z_live.jsonl"),
        completed_session_log("session_z_live", "event_live", "live"),
    )?;
    write_session_index(
        &data_dir,
        &[
            ("session_a_old", "2026-06-09T00:01:00.000Z"),
            ("session_z_live", "2026-06-09T00:02:00.000Z"),
        ],
    )?;
    write_session_lock(&data_dir, "session_a_old", "2026-06-09T00:00:00.000Z")?;
    write_session_lock(&data_dir, "session_z_live", "2099-01-01T00:00:00.000Z")?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;

    let ids: Vec<&str> = sessions
        .iter()
        .map(|session| session.session_id.as_str())
        .collect();
    assert_eq!(ids, vec!["session_z_live", "session_a_old"]);
    let first = sessions
        .first()
        .map(to_value)
        .transpose()?
        .unwrap_or(Value::Null);
    let second = sessions
        .get(1)
        .map(to_value)
        .transpose()?
        .unwrap_or(Value::Null);
    assert_eq!(first.get("lockState").and_then(Value::as_str), Some("live"));
    assert_eq!(
        first.get("updatedAt").and_then(Value::as_str),
        Some("2026-06-09T00:02:00.000Z")
    );
    assert_eq!(
        second.get("lockState").and_then(Value::as_str),
        Some("stale")
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn sessions_keep_corrupt_indexed_jsonl_diagnostic() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("indexed-corrupt")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir
            .join("sessions")
            .join("session_indexed_corrupt.jsonl"),
        session_log(
            "session_indexed_corrupt",
            &[
                r#"{"eventId":"event_bad","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_other","durability":"durable","event":{"type":"task.completed","timestamp":"2026-06-09T00:00:00.000Z","sessionId":"session_other","message":"wrong session"}}"#,
            ],
        ),
    )?;
    write_session_index(
        &data_dir,
        &[("session_indexed_corrupt", "2026-06-09T00:03:00.000Z")],
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;

    assert_eq!(
        sessions.first().map(|session| session.state),
        Some(SessionLogState::Corrupt)
    );
    assert_eq!(sessions.first().map(|session| session.event_count), Some(0));
    assert_eq!(
        sessions
            .first()
            .and_then(|session| session.diagnostics.first())
            .map(|diagnostic| diagnostic.code.as_str()),
        Some("session_mismatch")
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn sessions_report_malformed_locks_as_corrupt_even_when_old() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("malformed-lock")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_bad_lock.jsonl"),
        completed_session_log("session_bad_lock", "event_valid", "done"),
    )?;
    write(
        data_dir.join("sessions").join("session_bad_lock.lock"),
        "{\"sessionId\":\n",
    )?;
    make_old(
        data_dir
            .join("sessions")
            .join("session_bad_lock.lock")
            .as_path(),
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let session = sessions
        .iter()
        .find(|item| item.session_id == "session_bad_lock")
        .ok_or("expected session_bad_lock")?;
    let serialized = to_value(session)?;

    assert_eq!(
        serialized.get("lockState").and_then(Value::as_str),
        Some("corrupt")
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn lists_sessions_and_reads_valid_events() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("valid")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_valid.jsonl"),
        session_log(
            "session_valid",
            &[
                r#"{"eventId":"event_1","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_valid","durability":"durable","event":{"type":"task.completed","timestamp":"2026-06-09T00:00:00.000Z","sessionId":"session_valid","message":"done"}}"#,
            ],
        ),
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let log = read_session_events_from_data_dir(&data_dir, "session_valid")?;

    assert_eq!(sessions.len(), 1);
    assert_eq!(
        sessions.first().map(|session| session.session_id.as_str()),
        Some("session_valid")
    );
    assert_eq!(
        sessions.first().map(|session| session.state),
        Some(SessionLogState::Available)
    );
    assert_eq!(sessions.first().map(|session| session.event_count), Some(1));
    assert_eq!(log.envelopes.len(), 1);
    assert_eq!(log.state, SessionLogState::Available);
    remove_dir_all(data_dir)?;
    Ok(())
}

fn session_log(session_id: &str, event_records: &[&str]) -> String {
    let records: Vec<String> = event_records
        .iter()
        .map(|record| (*record).to_owned())
        .collect();
    session_log_records(session_id, &records)
}

fn completed_session_log(session_id: &str, event_id: &str, message: &str) -> String {
    session_log_records(
        session_id,
        &[format!(
            "{{\"eventId\":\"{}\",\"sequence\":0,\"createdAt\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"durability\":\"durable\",\"event\":{{\"type\":\"task.completed\",\"timestamp\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"message\":\"{}\"}}}}",
            event_id, session_id, session_id, message,
        )],
    )
}

fn session_log_records(session_id: &str, event_records: &[String]) -> String {
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

fn write_session_index(data_dir: &Path, records: &[(&str, &str)]) -> Result<(), Box<dyn Error>> {
    let session_records: Vec<Value> = records
        .iter()
        .map(|(session_id, updated_at)| {
            json!({
                "kind": "session",
                "sessionId": session_id,
                "status": "stopped",
                "startedAt": "2026-06-09T00:00:00.000Z",
                "eventCount": 1,
                "updatedAt": updated_at,
                "sourceFilePath": data_dir
                    .join("sessions")
                    .join(format!("{session_id}.jsonl"))
                    .to_string_lossy()
                    .to_string(),
            })
        })
        .collect();
    let index = json!({
        "version": 1,
        "records": session_records,
        "diagnostics": [],
    });
    write(
        data_dir.join("session-index.json"),
        format!("{}\n", serde_json::to_string_pretty(&index)?),
    )?;
    Ok(())
}

fn write_session_lock(
    data_dir: &Path,
    session_id: &str,
    heartbeat_at: &str,
) -> Result<(), Box<dyn Error>> {
    let lock = json!({
        "sessionId": session_id,
        "ownerId": format!("owner-{session_id}"),
        "createdAt": "2026-06-09T00:00:00.000Z",
        "updatedAt": heartbeat_at,
        "heartbeatAt": heartbeat_at,
    });
    write(
        data_dir.join("sessions").join(format!("{session_id}.lock")),
        format!("{}\n", serde_json::to_string(&lock)?),
    )?;
    Ok(())
}

fn make_old(path: &Path) -> Result<(), Box<dyn Error>> {
    let status = Command::new("touch")
        .args(["-t", "197001010000.00"])
        .arg(path)
        .status()?;
    if status.success() {
        return Ok(());
    }
    Err(format!("touch failed for {}", path.display()).into())
}

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}
