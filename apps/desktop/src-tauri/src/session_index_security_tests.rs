use super::list_sessions_in_data_dir;
use serde_json::{Value, json};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn session_index_diagnostics_do_not_echo_untrusted_messages() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("index-diagnostic-sanitized")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_valid.jsonl"),
        session_log("session_valid"),
    )?;
    write(
        data_dir.join("sessions").join("session_clean.jsonl"),
        session_log("session_clean"),
    )?;
    write(
        data_dir.join("session-index.json"),
        serde_json::to_string(&json!({
            "version": 1,
            "records": [session_index_record(&data_dir, "session_valid"), session_index_record(&data_dir, "session_clean")],
            "diagnostics": [{
                "kind": "corrupt_jsonl",
                "sessionId": "session_valid",
                "filePath": "/tmp/session_valid.jsonl",
                "code": "unknown",
                "message": "github_pat_SECRET copied from a corrupt index",
                "lineNumber": 4,
            }],
        }))?,
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let serialized = serde_json::to_string(&sessions)?;

    assert!(!serialized.contains("github_pat_SECRET"));
    let valid = sessions
        .iter()
        .find(|session| session.session_id == "session_valid")
        .ok_or("expected session_valid")?;
    let clean = sessions
        .iter()
        .find(|session| session.session_id == "session_clean")
        .ok_or("expected session_clean")?;
    assert!(
        valid
            .diagnostics
            .iter()
            .any(|item| item.code == "index_diagnostic")
    );
    assert!(
        !clean
            .diagnostics
            .iter()
            .any(|item| item.code == "index_diagnostic")
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn session_index_corrupt_file_diagnostic_does_not_echo_parse_details() -> Result<(), Box<dyn Error>>
{
    let data_dir = temp_data_dir("index-parse-sanitized")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_valid.jsonl"),
        session_log("session_valid"),
    )?;
    write(data_dir.join("session-index.json"), "{\"version\":\n")?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let serialized = serde_json::to_string(&sessions)?;
    let session = sessions
        .iter()
        .find(|item| item.session_id == "session_valid")
        .ok_or("expected session_valid")?;
    let diagnostic = session
        .diagnostics
        .iter()
        .find(|item| item.code == "corrupt_index")
        .ok_or("expected corrupt_index diagnostic")?;

    assert_eq!(diagnostic.message, "session index could not be read");
    assert!(!serialized.contains("EOF while parsing"));
    assert!(!serialized.contains("line 1 column"));
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn session_index_rejects_truncated_diagnostic_records() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("index-diagnostic-shape")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_valid.jsonl"),
        session_log("session_valid"),
    )?;
    write(
        data_dir.join("session-index.json"),
        serde_json::to_string(&json!({
            "version": 1,
            "records": [session_index_record(&data_dir, "session_valid")],
            "diagnostics": [{
                "sessionId": "session_valid",
                "lineNumber": 4,
            }],
        }))?,
    )?;

    let sessions = list_sessions_in_data_dir(&data_dir)?;
    let session = sessions
        .iter()
        .find(|item| item.session_id == "session_valid")
        .ok_or("expected session_valid")?;

    assert!(
        session
            .diagnostics
            .iter()
            .any(|item| item.code == "corrupt_index")
    );
    assert!(
        !session
            .diagnostics
            .iter()
            .any(|item| item.code == "index_diagnostic")
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

fn session_log(session_id: &str) -> String {
    format!(
        "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n\
         {{\"kind\":\"mission-control.session-event\",\"version\":1,\"event\":{{\"eventId\":\"event_1\",\"sequence\":0,\"createdAt\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"durability\":\"durable\",\"event\":{{\"type\":\"task.completed\",\"timestamp\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"message\":\"done\"}}}}}}\n",
        session_id, session_id, session_id,
    )
}

fn session_index_record(data_dir: &Path, session_id: &str) -> Value {
    json!({
        "kind": "session",
        "sessionId": session_id,
        "status": "stopped",
        "startedAt": "2026-06-09T00:00:00.000Z",
        "eventCount": 1,
        "updatedAt": "2026-06-09T00:00:00.000Z",
        "sourceFilePath": data_dir
            .join("sessions")
            .join(format!("{session_id}.jsonl"))
            .to_string_lossy()
            .to_string(),
    })
}

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}
