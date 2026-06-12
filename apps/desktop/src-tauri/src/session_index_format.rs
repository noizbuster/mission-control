use crate::session_index_format_fields::{
    array_field, object, optional_non_empty_string_field, optional_positive_usize_field,
    optional_string_enum_field, optional_timestamp_field, optional_usize_field, require_shape,
    string_enum_field, string_field, timestamp_field, u64_field, usize_field,
};
use crate::session_index_format_records::{
    validate_approval_record, validate_provider_failure_record, validate_run_record,
    validate_tool_record,
};
use crate::session_protocol::AGENT_EVENT_TYPES;
use serde_json::{Map, Value};

const SESSION_INDEX_FILE_VERSION: u64 = 1;
const SESSION_STATUSES: &[&str] = &["idle", "running", "stopped", "failed"];
const DIAGNOSTIC_CODES: &[&str] = &[
    "invalid_session_id",
    "invalid_event",
    "invalid_sequence",
    "missing_header",
    "invalid_header",
    "corrupt_line",
    "session_mismatch",
    "lock_exists",
    "lock_failed",
    "write_failed",
    "unknown",
];

#[derive(Debug)]
pub(crate) struct SessionIndexFile {
    pub(crate) records: Vec<SessionIndexRecord>,
    pub(crate) diagnostics: Vec<SessionIndexDiagnosticRecord>,
}

#[derive(Debug)]
pub(crate) enum SessionIndexRecord {
    Session(SessionIndexSessionRecord),
    Other,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionIndexSessionRecord {
    pub(crate) session_id: String,
    pub(crate) event_count: usize,
    pub(crate) updated_at: String,
}

#[derive(Debug)]
pub(crate) struct SessionIndexDiagnosticRecord {
    pub(crate) session_id: String,
    pub(crate) line_number: Option<usize>,
}

pub(crate) fn parse_session_index_file(contents: &str) -> Result<SessionIndexFile, ()> {
    let value = serde_json::from_str::<Value>(contents).map_err(|_| ())?;
    let root = object(&value)?;
    require_shape(root, &["version", "records", "diagnostics"], &[])?;
    if u64_field(root, "version")? != SESSION_INDEX_FILE_VERSION {
        return Err(());
    }
    let records = array_field(root, "records")?
        .iter()
        .map(parse_record)
        .collect::<Result<Vec<_>, _>>()?;
    let diagnostics = array_field(root, "diagnostics")?
        .iter()
        .map(parse_diagnostic)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SessionIndexFile {
        records,
        diagnostics,
    })
}

fn parse_record(value: &Value) -> Result<SessionIndexRecord, ()> {
    let object = object(value)?;
    match string_field(object, "kind")? {
        "session" => parse_session_record(object).map(SessionIndexRecord::Session),
        "run" => validate_run_record(object).map(|()| SessionIndexRecord::Other),
        "approval" => validate_approval_record(object).map(|()| SessionIndexRecord::Other),
        "tool" => validate_tool_record(object).map(|()| SessionIndexRecord::Other),
        "provider_failure" => {
            validate_provider_failure_record(object).map(|()| SessionIndexRecord::Other)
        }
        _ => Err(()),
    }
}

fn parse_session_record(object: &Map<String, Value>) -> Result<SessionIndexSessionRecord, ()> {
    require_shape(
        object,
        &[
            "kind",
            "sessionId",
            "status",
            "startedAt",
            "eventCount",
            "updatedAt",
            "sourceFilePath",
        ],
        &["stoppedAt", "lastSequence", "lastEventId", "lastEventType"],
    )?;
    string_enum_field(object, "status", SESSION_STATUSES)?;
    timestamp_field(object, "startedAt")?;
    optional_timestamp_field(object, "stoppedAt")?;
    optional_usize_field(object, "lastSequence")?;
    optional_non_empty_string_field(object, "lastEventId")?;
    optional_string_enum_field(object, "lastEventType", AGENT_EVENT_TYPES)?;
    let updated_at = timestamp_field(object, "updatedAt")?.to_owned();
    Ok(SessionIndexSessionRecord {
        session_id: string_field(object, "sessionId")?.to_owned(),
        event_count: usize_field(object, "eventCount")?,
        updated_at,
    })
}

fn parse_diagnostic(value: &Value) -> Result<SessionIndexDiagnosticRecord, ()> {
    let object = object(value)?;
    require_shape(
        object,
        &["kind", "sessionId", "filePath", "code", "message"],
        &["lineNumber"],
    )?;
    if string_field(object, "kind")? != "corrupt_jsonl" {
        return Err(());
    }
    string_field(object, "filePath")?;
    string_enum_field(object, "code", DIAGNOSTIC_CODES)?;
    string_field(object, "message")?;
    Ok(SessionIndexDiagnosticRecord {
        session_id: string_field(object, "sessionId")?.to_owned(),
        line_number: optional_positive_usize_field(object, "lineNumber")?,
    })
}
