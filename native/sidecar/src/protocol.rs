use serde::{Deserialize, Serialize};

const SIDECAR_PROTOCOL_VERSION: u16 = 1;
const SIDECAR_PROTOCOL_V2_VERSION: u16 = 2;
const SIDECAR_PROTOCOL_V3_VERSION: u16 = 3;
const SIDECAR_TASK_RUN_CAPABILITY: &str = "task.run";
const SIDECAR_TASK_CANCEL_CAPABILITY: &str = "task.cancel";
const SIDECAR_SHELL_SESSION_CAPABILITY: &str = "shell.session";
const SIDECAR_PTY_ALLOC_CAPABILITY: &str = "pty.alloc";
const SIDECAR_ISO_RESOLVE_CAPABILITY: &str = "iso.resolve";
const SIDECAR_V1_CAPABILITIES: [&str; 1] = [SIDECAR_TASK_RUN_CAPABILITY];
const SIDECAR_V2_CAPABILITIES: [&str; 2] =
    [SIDECAR_TASK_RUN_CAPABILITY, SIDECAR_TASK_CANCEL_CAPABILITY];
const SIDECAR_V3_CAPABILITIES: [&str; 5] = [
    SIDECAR_TASK_RUN_CAPABILITY,
    SIDECAR_TASK_CANCEL_CAPABILITY,
    SIDECAR_SHELL_SESSION_CAPABILITY,
    SIDECAR_PTY_ALLOC_CAPABILITY,
    SIDECAR_ISO_RESOLVE_CAPABILITY,
];

#[derive(Debug, Clone, Copy, Default)]
pub struct SidecarProtocolOptions {
    pub enable_v2: bool,
    pub enable_v3: bool,
}

impl SidecarProtocolOptions {
    pub fn from_env() -> Self {
        Self {
            enable_v2: std::env::var("MCTRL_SIDECAR_V2").as_deref() == Ok("1"),
            enable_v3: std::env::var("MCTRL_SIDECAR_V3").as_deref() == Ok("1"),
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarCommand {
    #[serde(rename_all = "camelCase")]
    Handshake {
        id: String,
        payload: SidecarHandshakePayload,
    },
    #[serde(rename_all = "camelCase")]
    RunTask {
        id: String,
        payload: SidecarTaskPayload,
    },
    #[serde(rename_all = "camelCase")]
    CancelTask {
        id: String,
        payload: SidecarCancelTaskPayload,
    },
    #[serde(rename_all = "camelCase")]
    StreamOpen {
        id: String,
        payload: SidecarStreamOpenPayload,
    },
    #[serde(rename_all = "camelCase")]
    StreamClose {
        id: String,
        payload: SidecarStreamClosePayload,
    },
    #[serde(rename_all = "camelCase")]
    IsoResolve {
        id: String,
        payload: SidecarIsoResolvePayload,
    },
    #[serde(rename_all = "camelCase")]
    IsoDiff {
        id: String,
        payload: SidecarIsoDiffPayload,
    },
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SidecarHandshakePayload {
    pub protocol_version: u16,
    pub client_name: String,
    pub requested_capabilities: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SidecarTaskPayload {
    pub label: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SidecarCancelTaskPayload {
    pub task_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SidecarStreamOpenPayload {
    pub session_id: String,
    pub kind: String,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SidecarStreamClosePayload {
    pub session_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SidecarIsoResolvePayload {
    pub target: String,
    pub method: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SidecarIsoDiffPayload {
    pub target: String,
    pub baseline: String,
    pub current: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarResponse<'a> {
    #[serde(rename_all = "camelCase")]
    HandshakeCompleted {
        id: &'a str,
        protocol_version: u16,
        capabilities: &'a [&'a str],
    },
    TaskProgress {
        id: &'a str,
        progress: f64,
    },
    TaskCompleted {
        id: &'a str,
        result: SidecarTaskResult<'a>,
    },
    TaskFailed {
        id: &'a str,
        error: SidecarTaskError<'a>,
    },
    TaskCancelled {
        id: &'a str,
        reason: &'a str,
    },
    #[serde(rename_all = "camelCase")]
    StreamFrame {
        session_id: String,
        seq: u64,
        payload: String,
        end: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    IsoResolved {
        id: String,
        payload: SidecarIsoResolveResult,
    },
    #[serde(rename_all = "camelCase")]
    IsoDiffed {
        id: String,
        payload: SidecarIsoDiffResult,
    },
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SidecarTaskResult<'a> {
    pub message: &'a str,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarTaskError<'a> {
    pub code: &'a str,
    pub message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SidecarIsoResolveResult {
    pub resolved: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SidecarIsoDiffResult {
    pub diff: String,
    pub identical: bool,
}

pub fn parse_command_with_options(
    input: &str,
    options: SidecarProtocolOptions,
) -> anyhow::Result<SidecarCommand> {
    let command = serde_json::from_str::<SidecarCommand>(input)?;
    match &command {
        SidecarCommand::Handshake { payload, .. } => validate_handshake_payload(payload, options)?,
        SidecarCommand::CancelTask { .. } if !options.enable_v2 => {
            anyhow::bail!("sidecar cancel_task requires protocol v2 feature flag");
        }
        SidecarCommand::StreamOpen { .. }
        | SidecarCommand::StreamClose { .. }
        | SidecarCommand::IsoResolve { .. }
        | SidecarCommand::IsoDiff { .. }
            if !options.enable_v3 =>
        {
            anyhow::bail!("sidecar v3 command requires protocol v3 feature flag");
        }
        SidecarCommand::RunTask { .. }
        | SidecarCommand::CancelTask { .. }
        | SidecarCommand::StreamOpen { .. }
        | SidecarCommand::StreamClose { .. }
        | SidecarCommand::IsoResolve { .. }
        | SidecarCommand::IsoDiff { .. } => {}
    }
    Ok(command)
}

pub fn handshake_completed_response_for_version(
    id: &str,
    protocol_version: u16,
    options: SidecarProtocolOptions,
) -> anyhow::Result<String> {
    let (response_version, capabilities): (u16, &[&str]) =
        if protocol_version == SIDECAR_PROTOCOL_V3_VERSION && options.enable_v3 {
            (SIDECAR_PROTOCOL_V3_VERSION, &SIDECAR_V3_CAPABILITIES)
        } else if protocol_version == SIDECAR_PROTOCOL_V2_VERSION && options.enable_v2 {
            (SIDECAR_PROTOCOL_V2_VERSION, &SIDECAR_V2_CAPABILITIES)
        } else {
            (SIDECAR_PROTOCOL_VERSION, &SIDECAR_V1_CAPABILITIES)
        };
    let response = SidecarResponse::HandshakeCompleted {
        id,
        protocol_version: response_version,
        capabilities,
    };
    let encoded = serde_json::to_string(&response)?;
    Ok(encoded)
}

pub fn task_progress_response(id: &str, progress: f64) -> anyhow::Result<String> {
    let response = SidecarResponse::TaskProgress { id, progress };
    let encoded = serde_json::to_string(&response)?;
    Ok(encoded)
}

pub fn task_completed_response(id: &str, message: &str) -> anyhow::Result<String> {
    let response = SidecarResponse::TaskCompleted {
        id,
        result: SidecarTaskResult { message },
    };
    let encoded = serde_json::to_string(&response)?;
    Ok(encoded)
}

pub fn task_failed_response(
    id: &str,
    code: &str,
    message: &str,
    retryable: Option<bool>,
) -> anyhow::Result<String> {
    let response = SidecarResponse::TaskFailed {
        id,
        error: SidecarTaskError {
            code,
            message,
            retryable,
        },
    };
    let encoded = serde_json::to_string(&response)?;
    Ok(encoded)
}

pub fn task_cancelled_response(id: &str, reason: &str) -> anyhow::Result<String> {
    let response = SidecarResponse::TaskCancelled { id, reason };
    let encoded = serde_json::to_string(&response)?;
    Ok(encoded)
}

pub fn stream_frame_response(
    session_id: &str,
    seq: u64,
    payload: &str,
    end: bool,
    error: Option<&str>,
) -> anyhow::Result<String> {
    let response = SidecarResponse::StreamFrame {
        session_id: session_id.to_string(),
        seq,
        payload: payload.to_string(),
        end,
        error: error.map(|e| e.to_string()),
    };
    let encoded = serde_json::to_string(&response)?;
    Ok(encoded)
}

pub fn stream_frames_for_session(
    session_id: &str,
    payloads: &[&str],
) -> anyhow::Result<Vec<String>> {
    let mut frames = Vec::with_capacity(payloads.len());
    let last_idx = payloads.len().saturating_sub(1);
    for (seq, payload) in payloads.iter().enumerate() {
        let is_last = seq == last_idx;
        frames.push(stream_frame_response(session_id, seq as u64, payload, is_last, None)?);
    }
    Ok(frames)
}

pub fn iso_resolved_response(
    id: &str,
    resolved: &str,
    method: Option<&str>,
) -> anyhow::Result<String> {
    let response = SidecarResponse::IsoResolved {
        id: id.to_string(),
        payload: SidecarIsoResolveResult {
            resolved: resolved.to_string(),
            method: method.map(|m| m.to_string()),
        },
    };
    let encoded = serde_json::to_string(&response)?;
    Ok(encoded)
}

pub fn iso_diffed_response(id: &str, diff: &str, identical: bool) -> anyhow::Result<String> {
    let response = SidecarResponse::IsoDiffed {
        id: id.to_string(),
        payload: SidecarIsoDiffResult {
            diff: diff.to_string(),
            identical,
        },
    };
    let encoded = serde_json::to_string(&response)?;
    Ok(encoded)
}

fn validate_handshake_payload(
    payload: &SidecarHandshakePayload,
    options: SidecarProtocolOptions,
) -> anyhow::Result<()> {
    match payload.protocol_version {
        SIDECAR_PROTOCOL_VERSION => validate_requested_capabilities(payload, CapabilityTier::V1),
        SIDECAR_PROTOCOL_V2_VERSION if options.enable_v2 => {
            validate_requested_capabilities(payload, CapabilityTier::V2)
        }
        SIDECAR_PROTOCOL_V3_VERSION if options.enable_v3 => {
            validate_requested_capabilities(payload, CapabilityTier::V3)
        }
        version => anyhow::bail!("unsupported sidecar protocol version {}", version),
    }
}

#[derive(Clone, Copy)]
enum CapabilityTier {
    V1,
    V2,
    V3,
}

fn validate_requested_capabilities(
    payload: &SidecarHandshakePayload,
    tier: CapabilityTier,
) -> anyhow::Result<()> {
    let Some(capabilities) = &payload.requested_capabilities else {
        return Ok(());
    };
    for capability in capabilities {
        let allowed = match capability.as_str() {
            SIDECAR_TASK_RUN_CAPABILITY => true,
            SIDECAR_TASK_CANCEL_CAPABILITY => matches!(tier, CapabilityTier::V2 | CapabilityTier::V3),
            SIDECAR_SHELL_SESSION_CAPABILITY
            | SIDECAR_PTY_ALLOC_CAPABILITY
            | SIDECAR_ISO_RESOLVE_CAPABILITY => matches!(tier, CapabilityTier::V3),
            _ => false,
        };
        if !allowed {
            anyhow::bail!("unsupported sidecar capability {}", capability);
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
