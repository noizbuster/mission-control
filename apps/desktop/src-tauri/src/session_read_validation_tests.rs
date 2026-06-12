use super::{SessionLogState, read_session_events_from_data_dir};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn corrupt_session_returns_valid_prefix_and_diagnostic() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("corrupt")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_corrupt.jsonl"),
        format!(
            "{}{}",
            session_log(
                "session_corrupt",
                &[
                    r#"{"eventId":"event_1","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_corrupt","durability":"durable","event":{"type":"task.completed","timestamp":"2026-06-09T00:00:00.000Z","sessionId":"session_corrupt","message":"done"}}"#,
                ],
            ),
            "{bad json\n",
        ),
    )?;

    let log = read_session_events_from_data_dir(&data_dir, "session_corrupt")?;

    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 1);
    assert_eq!(log.diagnostics.len(), 1);
    assert_eq!(
        log.diagnostics
            .first()
            .and_then(|diagnostic| diagnostic.line_number),
        Some(3)
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn schema_invalid_envelope_returns_diagnostic() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("invalid-envelope")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_invalid.jsonl"),
        session_log("session_invalid", &[r#"{"eventId":"event_1"}"#]),
    )?;

    let log = read_session_events_from_data_dir(&data_dir, "session_invalid")?;

    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 0);
    assert_eq!(log.diagnostics.len(), 1);
    assert_eq!(
        log.diagnostics
            .first()
            .and_then(|diagnostic| diagnostic.line_number),
        Some(2)
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn schema_invalid_envelope_enum_values_return_diagnostic() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("invalid-envelope-enum")?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir.join("sessions").join("session_invalid_enum.jsonl"),
        session_log(
            "session_invalid_enum",
            &[
                r#"{"eventId":"event_1","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_invalid_enum","durability":"archived","event":{"type":"task.unknown","timestamp":"not-a-date"}}"#,
            ],
        ),
    )?;

    let log = read_session_events_from_data_dir(&data_dir, "session_invalid_enum")?;

    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 0);
    assert_eq!(log.diagnostics.len(), 1);
    assert_eq!(
        log.diagnostics
            .first()
            .and_then(|diagnostic| diagnostic.line_number),
        Some(2)
    );
    remove_dir_all(data_dir)?;
    Ok(())
}

#[test]
fn missing_session_is_non_crashing_state() -> Result<(), Box<dyn Error>> {
    let data_dir = temp_data_dir("missing")?;

    let log = read_session_events_from_data_dir(&data_dir, "session_missing")?;

    assert_eq!(log.state, SessionLogState::Missing);
    assert_eq!(log.envelopes.len(), 0);
    assert_eq!(log.diagnostics.len(), 0);
    if data_dir.exists() {
        remove_dir_all(data_dir)?;
    }
    Ok(())
}

fn session_log(session_id: &str, event_records: &[&str]) -> String {
    let mut output = format!(
        "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n",
        session_id,
    );
    for event_record in event_records {
        output.push_str(&format!(
            "{{\"kind\":\"mission-control.session-event\",\"version\":1,\"event\":{event_record}}}\n",
        ));
    }
    output
}

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}
