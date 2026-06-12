use crate::session_index_format_fields::{
    boolean_field, object_field, optional_array_field, optional_non_empty_string_field,
    optional_object_field, optional_string_array_field, optional_string_enum_field,
    optional_timestamp_field, require_shape, string_enum_field, string_field, timestamp_field,
    usize_field,
};
use crate::session_protocol::AGENT_EVENT_TYPES;
use serde_json::{Map, Value};

const RUN_COMMANDS: &[&str] = &["wake", "run", "resume", "interrupt", "steer", "queue"];
const RUN_STATES: &[&str] = &[
    "idle",
    "running",
    "interrupted",
    "completed",
    "failed",
    "blocked_on_approval",
];
const APPROVAL_STATES: &[&str] = &["pending", "approved", "denied", "expired", "cancelled"];
const TOOL_STATUSES: &[&str] = &["started", "completed", "failed"];
const ERROR_CODES: &[&str] = &[
    "provider_auth_failed",
    "provider_rate_limited",
    "provider_timeout",
    "provider_aborted",
    "provider_context_overflow",
    "tool_failed",
    "schema_invalid",
    "unknown",
];

pub(crate) fn validate_run_record(object: &Map<String, Value>) -> Result<(), ()> {
    require_shape(
        object,
        &[
            "kind",
            "sessionId",
            "eventId",
            "sequence",
            "timestamp",
            "eventType",
        ],
        &[
            "command",
            "state",
            "runId",
            "inputId",
            "providerTurnId",
            "reason",
            "errorCode",
        ],
    )?;
    string_field(object, "sessionId")?;
    string_field(object, "eventId")?;
    usize_field(object, "sequence")?;
    timestamp_field(object, "timestamp")?;
    string_enum_field(object, "eventType", AGENT_EVENT_TYPES)?;
    optional_string_enum_field(object, "command", RUN_COMMANDS)?;
    optional_string_enum_field(object, "state", RUN_STATES)?;
    optional_non_empty_string_field(object, "runId")?;
    optional_non_empty_string_field(object, "inputId")?;
    optional_non_empty_string_field(object, "providerTurnId")?;
    optional_non_empty_string_field(object, "reason")?;
    optional_string_enum_field(object, "errorCode", ERROR_CODES)?;
    Ok(())
}

pub(crate) fn validate_approval_record(object: &Map<String, Value>) -> Result<(), ()> {
    require_shape(
        object,
        &[
            "kind",
            "sessionId",
            "approvalId",
            "eventId",
            "state",
            "subject",
            "requestedAt",
            "updatedAt",
        ],
        &["decidedAt"],
    )?;
    string_field(object, "sessionId")?;
    string_field(object, "approvalId")?;
    string_field(object, "eventId")?;
    string_enum_field(object, "state", APPROVAL_STATES)?;
    object_field(object, "subject")?;
    timestamp_field(object, "requestedAt")?;
    optional_timestamp_field(object, "decidedAt")?;
    timestamp_field(object, "updatedAt")?;
    Ok(())
}

pub(crate) fn validate_tool_record(object: &Map<String, Value>) -> Result<(), ()> {
    require_shape(
        object,
        &["kind", "sessionId", "toolId", "status"],
        &[
            "startedAt",
            "completedAt",
            "failedAt",
            "lastMessage",
            "result",
            "appliedFiles",
        ],
    )?;
    string_field(object, "sessionId")?;
    string_field(object, "toolId")?;
    string_enum_field(object, "status", TOOL_STATUSES)?;
    optional_timestamp_field(object, "startedAt")?;
    optional_timestamp_field(object, "completedAt")?;
    optional_timestamp_field(object, "failedAt")?;
    optional_non_empty_string_field(object, "lastMessage")?;
    optional_object_field(object, "result")?;
    optional_string_array_field(object, "appliedFiles")?;
    Ok(())
}

pub(crate) fn validate_provider_failure_record(object: &Map<String, Value>) -> Result<(), ()> {
    require_shape(
        object,
        &[
            "kind",
            "sessionId",
            "eventId",
            "timestamp",
            "requestId",
            "error",
        ],
        &["providerTurnId"],
    )?;
    string_field(object, "sessionId")?;
    string_field(object, "eventId")?;
    timestamp_field(object, "timestamp")?;
    string_field(object, "requestId")?;
    optional_non_empty_string_field(object, "providerTurnId")?;
    validate_protocol_error(object_field(object, "error")?)
}

fn validate_protocol_error(object: &Map<String, Value>) -> Result<(), ()> {
    require_shape(object, &["code", "message", "retryable"], &["redactions"])?;
    string_enum_field(object, "code", ERROR_CODES)?;
    string_field(object, "message")?;
    boolean_field(object, "retryable")?;
    optional_array_field(object, "redactions")?;
    Ok(())
}
