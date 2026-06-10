use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPromptCommandInput {
    pub session_id: String,
    pub prompt: String,
    pub model_provider_selection: Option<Value>,
    pub parent_message_id: Option<String>,
    pub resume: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRunCommandInput {
    pub session_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApprovalDecisionInput {
    pub session_id: String,
    pub approval_id: String,
    pub state: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCommandReceipt {
    pub session_id: String,
    pub status: String,
    pub events_written: usize,
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn submit_prompt(input: DesktopPromptCommandInput) -> Result<DesktopCommandReceipt, String> {
    Ok(command_bridge_receipt(input.session_id))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn queue_follow_up(input: DesktopPromptCommandInput) -> Result<DesktopCommandReceipt, String> {
    Ok(command_bridge_receipt(input.session_id))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn steer_run(input: DesktopPromptCommandInput) -> Result<DesktopCommandReceipt, String> {
    Ok(command_bridge_receipt(input.session_id))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn interrupt_run(input: DesktopRunCommandInput) -> Result<DesktopCommandReceipt, String> {
    Ok(DesktopCommandReceipt {
        session_id: input.session_id,
        status: "interrupted".to_owned(),
        events_written: 0,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn resume_run(input: DesktopRunCommandInput) -> Result<DesktopCommandReceipt, String> {
    Ok(command_bridge_receipt(input.session_id))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn decide_approval(
    input: DesktopApprovalDecisionInput,
) -> Result<DesktopCommandReceipt, String> {
    Ok(DesktopCommandReceipt {
        session_id: input.session_id,
        status: if input.state == "approved" {
            "completed".to_owned()
        } else {
            "blocked".to_owned()
        },
        events_written: 0,
    })
}

fn command_bridge_receipt(session_id: String) -> DesktopCommandReceipt {
    DesktopCommandReceipt {
        session_id,
        status: "failed".to_owned(),
        events_written: 0,
    }
}
