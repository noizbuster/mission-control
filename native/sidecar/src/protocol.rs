use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SidecarCommand {
    pub r#type: String,
    pub id: String,
    pub payload: SidecarTaskPayload,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SidecarTaskPayload {
    pub label: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarResponse<'a> {
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
    Ok(command)
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
    use super::{parse_command, task_completed_response, task_progress_response};

    #[test]
    fn parses_run_task_command_with_payload() -> anyhow::Result<()> {
        let command = parse_command(r#"{"type":"run_task","id":"task_1","payload":{"label":"demo"}}"#)?;

        assert_eq!(command.r#type, "run_task");
        assert_eq!(command.id, "task_1");
        assert_eq!(command.payload.label, "demo");
        Ok(())
    }

    #[test]
    fn serializes_progress_and_completion_responses() -> anyhow::Result<()> {
        let progress = task_progress_response("task_1", 0.5)?;
        let completed = task_completed_response("task_1", "completed by rust sidecar")?;

        assert_eq!(progress, r#"{"type":"task_progress","id":"task_1","progress":0.5}"#);
        assert_eq!(
            completed,
            r#"{"type":"task_completed","id":"task_1","result":{"message":"completed by rust sidecar"}}"#
        );
        Ok(())
    }
}
