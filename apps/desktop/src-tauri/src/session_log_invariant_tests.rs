use super::{SessionLogState, read_session_events_from_data_dir};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn corrupts_when_event_record_version_is_unsupported() -> Result<(), Box<dyn Error>> {
    // Given
    let fixture = write_fixture(
        "record-version",
        "session_record_version",
        &[event_record_with_version(
            2,
            valid_envelope("event_1", 0, "session_record_version", "durable"),
        )],
    )?;

    // When
    let log = read_session_events_from_data_dir(&fixture.data_dir, "session_record_version")?;

    // Then
    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 0);
    assert_eq!(log.diagnostics[0].line_number, Some(2));
    remove_dir_all(fixture.data_dir)?;
    Ok(())
}

#[test]
fn corrupts_when_envelope_session_differs_from_log() -> Result<(), Box<dyn Error>> {
    // Given
    let fixture = write_fixture(
        "envelope-session",
        "session_a",
        &[event_record(valid_envelope(
            "event_1",
            0,
            "session_b",
            "durable",
        ))],
    )?;

    // When
    let log = read_session_events_from_data_dir(&fixture.data_dir, "session_a")?;

    // Then
    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 0);
    assert_eq!(log.diagnostics[0].code, "session_mismatch");
    assert_eq!(log.diagnostics[0].line_number, Some(2));
    remove_dir_all(fixture.data_dir)?;
    Ok(())
}

#[test]
fn corrupts_when_payload_session_differs_from_log() -> Result<(), Box<dyn Error>> {
    // Given
    let envelope = r#"{"eventId":"event_1","sequence":0,"createdAt":"2026-06-09T00:00:00.000Z","sessionId":"session_a","durability":"durable","event":{"type":"task.completed","timestamp":"2026-06-09T00:00:00.000Z","sessionId":"session_b","message":"cross session"}}"#;
    let fixture = write_fixture("payload-session", "session_a", &[event_record(envelope)])?;

    // When
    let log = read_session_events_from_data_dir(&fixture.data_dir, "session_a")?;

    // Then
    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 0);
    assert_eq!(log.diagnostics[0].code, "session_mismatch");
    assert_eq!(log.diagnostics[0].line_number, Some(2));
    remove_dir_all(fixture.data_dir)?;
    Ok(())
}

#[test]
fn corrupts_when_persisted_event_is_ephemeral() -> Result<(), Box<dyn Error>> {
    // Given
    let fixture = write_fixture(
        "ephemeral",
        "session_ephemeral",
        &[event_record(valid_envelope(
            "event_1",
            0,
            "session_ephemeral",
            "ephemeral",
        ))],
    )?;

    // When
    let log = read_session_events_from_data_dir(&fixture.data_dir, "session_ephemeral")?;

    // Then
    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 0);
    assert_eq!(log.diagnostics[0].line_number, Some(2));
    remove_dir_all(fixture.data_dir)?;
    Ok(())
}

#[test]
fn corrupts_when_sequence_does_not_increase() -> Result<(), Box<dyn Error>> {
    // Given
    let fixture = write_fixture(
        "sequence",
        "session_sequence",
        &[
            event_record(valid_envelope("event_1", 1, "session_sequence", "durable")),
            event_record(valid_envelope("event_2", 1, "session_sequence", "durable")),
        ],
    )?;

    // When
    let log = read_session_events_from_data_dir(&fixture.data_dir, "session_sequence")?;

    // Then
    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 1);
    assert_eq!(log.diagnostics[0].line_number, Some(3));
    remove_dir_all(fixture.data_dir)?;
    Ok(())
}

#[test]
fn corrupts_when_event_id_repeats() -> Result<(), Box<dyn Error>> {
    // Given
    let fixture = write_fixture(
        "duplicate",
        "session_duplicate",
        &[
            event_record(valid_envelope("event_1", 0, "session_duplicate", "durable")),
            event_record(valid_envelope("event_1", 1, "session_duplicate", "durable")),
        ],
    )?;

    // When
    let log = read_session_events_from_data_dir(&fixture.data_dir, "session_duplicate")?;

    // Then
    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 1);
    assert_eq!(log.diagnostics[0].line_number, Some(3));
    remove_dir_all(fixture.data_dir)?;
    Ok(())
}

#[test]
fn corrupts_when_datetime_has_impossible_calendar_values() -> Result<(), Box<dyn Error>> {
    // Given
    let envelope = r#"{"eventId":"event_1","sequence":0,"createdAt":"2026-99-99T99:99:99.999Z","sessionId":"session_invalid_date","durability":"durable","event":{"type":"task.completed","timestamp":"2026-99-99T99:99:99.999Z","sessionId":"session_invalid_date","message":"invalid date"}}"#;
    let fixture = write_fixture(
        "invalid-date",
        "session_invalid_date",
        &[event_record(envelope)],
    )?;

    // When
    let log = read_session_events_from_data_dir(&fixture.data_dir, "session_invalid_date")?;

    // Then
    assert_eq!(log.state, SessionLogState::Corrupt);
    assert_eq!(log.envelopes.len(), 0);
    assert_eq!(log.diagnostics[0].line_number, Some(2));
    remove_dir_all(fixture.data_dir)?;
    Ok(())
}

#[test]
fn parses_provider_failure_event_as_available() -> Result<(), Box<dyn Error>> {
    // Given
    let fixture = write_fixture(
        "provider-failure",
        "session_provider_failure",
        &[event_record(provider_failure_envelope(
            "session_provider_failure",
        ))],
    )?;

    // When
    let log = read_session_events_from_data_dir(&fixture.data_dir, "session_provider_failure")?;

    // Then
    assert_eq!(log.state, SessionLogState::Available);
    assert_eq!(log.envelopes.len(), 1);
    assert_eq!(
        log.envelopes[0]
            .get("event")
            .and_then(|event| event.get("type"))
            .and_then(serde_json::Value::as_str),
        Some("model.call.failed"),
    );
    assert_eq!(
        log.envelopes[0]
            .get("event")
            .and_then(|event| event.get("providerStreamChunk"))
            .and_then(|chunk| chunk.get("kind"))
            .and_then(serde_json::Value::as_str),
        Some("response_failed"),
    );
    remove_dir_all(fixture.data_dir)?;
    Ok(())
}

struct Fixture {
    data_dir: PathBuf,
}

fn write_fixture(
    label: &str,
    session_id: &str,
    event_records: &[String],
) -> Result<Fixture, Box<dyn Error>> {
    let data_dir = temp_data_dir(label)?;
    create_dir_all(data_dir.join("sessions"))?;
    write(
        data_dir
            .join("sessions")
            .join(format!("{session_id}.jsonl")),
        session_log(session_id, event_records),
    )?;
    Ok(Fixture { data_dir })
}

fn session_log(session_id: &str, event_records: &[String]) -> String {
    let mut output = format!(
        "{{\"kind\":\"mission-control.session-log\",\"version\":1,\"sessionId\":\"{}\",\"createdAt\":\"2026-06-09T00:00:00.000Z\"}}\n",
        session_id,
    );
    for event_record in event_records {
        output.push_str(event_record);
    }
    output
}

fn event_record(envelope: impl AsRef<str>) -> String {
    event_record_with_version(1, envelope)
}

fn event_record_with_version(version: u8, envelope: impl AsRef<str>) -> String {
    format!(
        "{{\"kind\":\"mission-control.session-event\",\"version\":{},\"event\":{}}}\n",
        version,
        envelope.as_ref(),
    )
}

fn valid_envelope(event_id: &str, sequence: u64, session_id: &str, durability: &str) -> String {
    format!(
        "{{\"eventId\":\"{}\",\"sequence\":{},\"createdAt\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"durability\":\"{}\",\"event\":{{\"type\":\"task.completed\",\"timestamp\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"message\":\"done\"}}}}",
        event_id, sequence, session_id, durability, session_id,
    )
}

fn provider_failure_envelope(session_id: &str) -> String {
    format!(
        "{{\"eventId\":\"provider_failed_1\",\"sequence\":0,\"createdAt\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"durability\":\"durable\",\"correlationId\":\"request_provider_failed\",\"event\":{{\"type\":\"model.call.failed\",\"timestamp\":\"2026-06-09T00:00:00.000Z\",\"sessionId\":\"{}\",\"taskId\":\"turn_failed\",\"message\":\"provider timeout before completion\",\"providerStreamChunk\":{{\"kind\":\"response_failed\",\"requestId\":\"request_provider_failed\",\"sequence\":1,\"error\":{{\"code\":\"provider_timeout\",\"message\":\"provider timeout before completion\",\"retryable\":true}}}}}}}}",
        session_id, session_id,
    )
}

fn temp_data_dir(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok(std::env::temp_dir().join(format!("mission-control-desktop-{label}-{nanos}")))
}
