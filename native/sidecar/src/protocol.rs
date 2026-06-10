use serde::{Deserialize, Serialize};

const SIDECAR_PROTOCOL_VERSION: u16 = 1;
const SIDECAR_TASK_RUN_CAPABILITY: &str = "task.run";
const SIDECAR_CAPABILITIES: [&str; 1] = [SIDECAR_TASK_RUN_CAPABILITY];

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
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SidecarHandshakePayload {
    pub protocol_version: u16,
    pub client_name: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SidecarTaskPayload {
    pub label: String,
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
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SidecarTaskResult<'a> {
    pub message: &'a str,
}

pub fn parse_command(input: &str) -> anyhow::Result<SidecarCommand> {
    let command = serde_json::from_str::<SidecarCommand>(input)?;
    if let SidecarCommand::Handshake { payload, .. } = &command {
        if payload.protocol_version != SIDECAR_PROTOCOL_VERSION {
            anyhow::bail!(
                "unsupported sidecar protocol version {}",
                payload.protocol_version
            );
        }
    }
    Ok(command)
}

pub fn handshake_completed_response(id: &str) -> anyhow::Result<String> {
    let response = SidecarResponse::HandshakeCompleted {
        id,
        protocol_version: SIDECAR_PROTOCOL_VERSION,
        capabilities: &SIDECAR_CAPABILITIES,
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

#[cfg(test)]
mod tests {
    use super::{
        SidecarCommand, handshake_completed_response, parse_command, task_completed_response,
        task_progress_response,
    };

    #[test]
    fn parses_run_task_command_with_payload() -> anyhow::Result<()> {
        let command =
            parse_command(r#"{"type":"run_task","id":"task_1","payload":{"label":"demo"}}"#)?;

        match command {
            SidecarCommand::RunTask { id, payload } => {
                assert_eq!(id, "task_1");
                assert_eq!(payload.label, "demo");
            }
            SidecarCommand::Handshake { .. } => anyhow::bail!("expected run task command"),
        }
        Ok(())
    }

    #[test]
    fn parses_handshake_command_and_serializes_capabilities() -> anyhow::Result<()> {
        let command = parse_command(
            r#"{"type":"handshake","id":"handshake_1","payload":{"protocolVersion":1,"clientName":"mission-control-core"}}"#,
        )?;
        let response = handshake_completed_response("handshake_1")?;

        match command {
            SidecarCommand::Handshake { id, payload } => {
                assert_eq!(id, "handshake_1");
                assert_eq!(payload.protocol_version, 1);
                assert_eq!(payload.client_name, "mission-control-core");
            }
            SidecarCommand::RunTask { .. } => anyhow::bail!("expected handshake command"),
        }
        assert_eq!(
            response,
            r#"{"type":"handshake_completed","id":"handshake_1","protocolVersion":1,"capabilities":["task.run"]}"#
        );
        Ok(())
    }

    #[test]
    fn serializes_progress_and_completion_responses() -> anyhow::Result<()> {
        let progress = task_progress_response("task_1", 0.5)?;
        let completed = task_completed_response("task_1", "completed by rust sidecar")?;

        assert_eq!(
            progress,
            r#"{"type":"task_progress","id":"task_1","progress":0.5}"#
        );
        assert_eq!(
            completed,
            r#"{"type":"task_completed","id":"task_1","result":{"message":"completed by rust sidecar"}}"#
        );
        Ok(())
    }
}
