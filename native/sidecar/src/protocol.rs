use serde::{Deserialize, Serialize};

const SIDECAR_PROTOCOL_VERSION: u16 = 1;
const SIDECAR_PROTOCOL_V2_VERSION: u16 = 2;
const SIDECAR_TASK_RUN_CAPABILITY: &str = "task.run";
const SIDECAR_TASK_CANCEL_CAPABILITY: &str = "task.cancel";
const SIDECAR_V1_CAPABILITIES: [&str; 1] = [SIDECAR_TASK_RUN_CAPABILITY];
const SIDECAR_V2_CAPABILITIES: [&str; 2] =
    [SIDECAR_TASK_RUN_CAPABILITY, SIDECAR_TASK_CANCEL_CAPABILITY];

#[derive(Debug, Clone, Copy, Default)]
pub struct SidecarProtocolOptions {
    pub enable_v2: bool,
}

impl SidecarProtocolOptions {
    pub fn from_env() -> Self {
        Self {
            enable_v2: std::env::var("MCTRL_SIDECAR_V2").as_deref() == Ok("1"),
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
        SidecarCommand::RunTask { .. } | SidecarCommand::CancelTask { .. } => {}
    }
    Ok(command)
}

pub fn handshake_completed_response_for_version(
    id: &str,
    protocol_version: u16,
    options: SidecarProtocolOptions,
) -> anyhow::Result<String> {
    let (response_version, capabilities): (u16, &[&str]) =
        if protocol_version == SIDECAR_PROTOCOL_V2_VERSION && options.enable_v2 {
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

fn validate_handshake_payload(
    payload: &SidecarHandshakePayload,
    options: SidecarProtocolOptions,
) -> anyhow::Result<()> {
    match payload.protocol_version {
        SIDECAR_PROTOCOL_VERSION => validate_requested_capabilities(payload, false),
        SIDECAR_PROTOCOL_V2_VERSION if options.enable_v2 => {
            validate_requested_capabilities(payload, true)
        }
        version => anyhow::bail!("unsupported sidecar protocol version {}", version),
    }
}

fn validate_requested_capabilities(
    payload: &SidecarHandshakePayload,
    enable_v2: bool,
) -> anyhow::Result<()> {
    let Some(capabilities) = &payload.requested_capabilities else {
        return Ok(());
    };
    for capability in capabilities {
        match capability.as_str() {
            SIDECAR_TASK_RUN_CAPABILITY => {}
            SIDECAR_TASK_CANCEL_CAPABILITY if enable_v2 => {}
            SIDECAR_TASK_CANCEL_CAPABILITY => {
                anyhow::bail!("sidecar capability task.cancel requires protocol v2 feature flag");
            }
            unsupported => anyhow::bail!("unsupported sidecar capability {}", unsupported),
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
