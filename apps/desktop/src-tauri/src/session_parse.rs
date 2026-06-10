use crate::session_datetime::is_rfc3339_utc_millis;
use crate::session_log_scan::EventLogScan;
use crate::session_protocol::{
    AGENT_EVENT_TYPES, DURABLE_EVENT_DURABILITY, EVENT_DURABILITIES, SESSION_EVENT_RECORD_KIND,
    SESSION_LOG_HEADER_KIND, SESSION_LOG_RECORD_VERSION,
};
use crate::sessions::{DesktopSessionLog, SessionDiagnostic, SessionLogState};
use serde_json::Value;

pub(crate) fn empty_log(session_id: String, state: SessionLogState) -> DesktopSessionLog {
    DesktopSessionLog {
        session_id,
        state,
        contents: String::new(),
        envelopes: Vec::new(),
        diagnostics: Vec::new(),
    }
}

pub(crate) fn parse_session_contents(session_id: &str, contents: String) -> DesktopSessionLog {
    let lines: Vec<(usize, &str)> = contents
        .lines()
        .enumerate()
        .filter_map(|(index, line)| (!line.trim().is_empty()).then_some((index + 1, line)))
        .collect();
    if lines.is_empty() {
        return empty_log(session_id.to_owned(), SessionLogState::Empty);
    }
    let mut diagnostics = Vec::new();
    let mut envelopes = Vec::new();
    if let Err(diagnostic) = validate_header(session_id, lines[0].1, lines[0].0) {
        diagnostics.push(diagnostic);
        return log_with(session_id, contents, envelopes, diagnostics);
    }
    let mut scan = EventLogScan::default();
    for (line_number, line) in lines.iter().skip(1) {
        match parse_event_record(session_id, line, *line_number, &mut scan) {
            Ok(envelope) => envelopes.push(envelope),
            Err(diagnostic) => {
                diagnostics.push(diagnostic);
                break;
            }
        }
    }
    log_with(session_id, contents, envelopes, diagnostics)
}

fn validate_header(
    session_id: &str,
    line: &str,
    line_number: usize,
) -> Result<(), SessionDiagnostic> {
    let value = parse_json(line, line_number)?;
    if value.get("kind").and_then(Value::as_str) != Some(SESSION_LOG_HEADER_KIND) {
        return Err(diagnostic(
            "invalid_header",
            "session log header kind is invalid",
            Some(line_number),
        ));
    }
    if value.get("version").and_then(Value::as_u64) != Some(SESSION_LOG_RECORD_VERSION) {
        return Err(diagnostic(
            "invalid_header",
            "session log header version is unsupported",
            Some(line_number),
        ));
    }
    if value.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err(diagnostic(
            "session_mismatch",
            "session log header belongs to another session",
            Some(line_number),
        ));
    }
    Ok(())
}

fn parse_event_record(
    session_id: &str,
    line: &str,
    line_number: usize,
    scan: &mut EventLogScan,
) -> Result<Value, SessionDiagnostic> {
    let value = parse_json(line, line_number)?;
    if value.get("kind").and_then(Value::as_str) != Some(SESSION_EVENT_RECORD_KIND) {
        return Err(diagnostic(
            "corrupt_line",
            "event record kind is invalid",
            Some(line_number),
        ));
    }
    if value.get("version").and_then(Value::as_u64) != Some(SESSION_LOG_RECORD_VERSION) {
        return Err(diagnostic(
            "corrupt_line",
            "event record version is unsupported",
            Some(line_number),
        ));
    }
    let envelope = value.get("event").ok_or_else(|| {
        diagnostic(
            "corrupt_line",
            "event record is missing envelope",
            Some(line_number),
        )
    })?;
    validate_envelope(session_id, envelope, line_number, scan)?;
    Ok(envelope.clone())
}

fn parse_json(line: &str, line_number: usize) -> Result<Value, SessionDiagnostic> {
    serde_json::from_str::<Value>(line).map_err(|error| {
        diagnostic(
            "corrupt_line",
            &format!("line is not valid JSON: {error}"),
            Some(line_number),
        )
    })
}

fn validate_envelope(
    session_id: &str,
    envelope: &Value,
    line_number: usize,
    scan: &mut EventLogScan,
) -> Result<(), SessionDiagnostic> {
    let Some(event_id) = string_field(envelope, "eventId") else {
        return missing_fields(line_number);
    };
    let Some(sequence) = number_field(envelope, "sequence") else {
        return missing_fields(line_number);
    };
    let Some(created_at) = string_field(envelope, "createdAt") else {
        return missing_fields(line_number);
    };
    let Some(envelope_session_id) = string_field(envelope, "sessionId") else {
        return missing_fields(line_number);
    };
    let Some(durability) = string_field(envelope, "durability") else {
        return missing_fields(line_number);
    };
    if envelope_session_id != session_id {
        return Err(session_mismatch(line_number));
    }
    if !is_rfc3339_utc_millis(created_at)
        || !EVENT_DURABILITIES.contains(&durability)
        || durability != DURABLE_EVENT_DURABILITY
    {
        return Err(diagnostic(
            "corrupt_line",
            "event envelope has invalid protocol fields",
            Some(line_number),
        ));
    }
    let Some(event) = envelope.get("event") else {
        return Err(diagnostic(
            "corrupt_line",
            "event envelope is missing event payload",
            Some(line_number),
        ));
    };
    let Some(event_type) = string_field(event, "type") else {
        return event_missing_fields(line_number);
    };
    let Some(timestamp) = string_field(event, "timestamp") else {
        return event_missing_fields(line_number);
    };
    if string_field(event, "sessionId") != Some(session_id) {
        return Err(session_mismatch(line_number));
    }
    if !AGENT_EVENT_TYPES.contains(&event_type) || !is_rfc3339_utc_millis(timestamp) {
        return Err(diagnostic(
            "corrupt_line",
            "event payload has invalid protocol fields",
            Some(line_number),
        ));
    }
    scan.accept(event_id, sequence, line_number)?;
    Ok(())
}

fn number_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn missing_fields<T>(line_number: usize) -> Result<T, SessionDiagnostic> {
    Err(diagnostic(
        "corrupt_line",
        "event envelope is missing required fields",
        Some(line_number),
    ))
}

fn event_missing_fields<T>(line_number: usize) -> Result<T, SessionDiagnostic> {
    Err(diagnostic(
        "corrupt_line",
        "event payload is missing required fields",
        Some(line_number),
    ))
}

fn session_mismatch(line_number: usize) -> SessionDiagnostic {
    diagnostic(
        "session_mismatch",
        "event record belongs to another session",
        Some(line_number),
    )
}

fn log_with(
    session_id: &str,
    contents: String,
    envelopes: Vec<Value>,
    diagnostics: Vec<SessionDiagnostic>,
) -> DesktopSessionLog {
    DesktopSessionLog {
        session_id: session_id.to_owned(),
        state: if diagnostics.is_empty() {
            SessionLogState::Available
        } else {
            SessionLogState::Corrupt
        },
        contents,
        envelopes,
        diagnostics,
    }
}

fn diagnostic(code: &str, message: &str, line_number: Option<usize>) -> SessionDiagnostic {
    SessionDiagnostic {
        code: code.to_owned(),
        message: message.to_owned(),
        line_number,
    }
}
