use crate::desktop_command_bridge::DesktopCommandBridge;
use crate::sessions;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPromptCommandInput {
    pub session_id: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider_selection: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRunCommandInput {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApprovalDecisionInput {
    pub session_id: String,
    pub approval_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCommandReceipt {
    pub session_id: String,
    pub status: String,
    pub events_written: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDesktopProviderCredentialInput {
    pub provider_id: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_id: Option<String>,
    pub api_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProviderCredentialSummary {
    pub provider_id: String,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_credential: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_field_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmptyDesktopCommandInput {}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn submit_prompt(input: DesktopPromptCommandInput) -> Result<DesktopCommandReceipt, String> {
    let session_id = input.session_id.clone();
    with_resolved_data_dir(session_id, |data_dir| {
        submit_prompt_in_data_dir(input, data_dir)
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn queue_follow_up(input: DesktopPromptCommandInput) -> Result<DesktopCommandReceipt, String> {
    let session_id = input.session_id.clone();
    with_resolved_data_dir(session_id, |data_dir| {
        queue_follow_up_in_data_dir(input, data_dir)
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn steer_run(input: DesktopPromptCommandInput) -> Result<DesktopCommandReceipt, String> {
    let session_id = input.session_id.clone();
    with_resolved_data_dir(session_id, |data_dir| {
        steer_run_in_data_dir(input, data_dir)
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn interrupt_run(input: DesktopRunCommandInput) -> Result<DesktopCommandReceipt, String> {
    let session_id = input.session_id.clone();
    with_resolved_data_dir(session_id, |data_dir| {
        interrupt_run_in_data_dir(input, data_dir)
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn resume_run(input: DesktopRunCommandInput) -> Result<DesktopCommandReceipt, String> {
    let session_id = input.session_id.clone();
    with_resolved_data_dir(session_id, |data_dir| {
        resume_run_in_data_dir(input, data_dir)
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn decide_approval(
    input: DesktopApprovalDecisionInput,
) -> Result<DesktopCommandReceipt, String> {
    let session_id = input.session_id.clone();
    with_resolved_data_dir(session_id, |data_dir| {
        decide_approval_in_data_dir(input, data_dir)
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn list_provider_credentials() -> Result<Vec<DesktopProviderCredentialSummary>, String> {
    let data_dir = sessions::resolve_data_dir().map_err(|error| error.to_string())?;
    invoke_default_bridge_json(
        "listProviderCredentials",
        &EmptyDesktopCommandInput {},
        &data_dir,
    )
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn save_provider_credential(
    input: SaveDesktopProviderCredentialInput,
) -> Result<DesktopProviderCredentialSummary, String> {
    let data_dir = sessions::resolve_data_dir().map_err(|error| error.to_string())?;
    invoke_default_bridge_json("saveProviderCredential", &input, &data_dir)
}

pub(crate) fn submit_prompt_in_data_dir(
    input: DesktopPromptCommandInput,
    data_dir: &Path,
) -> Result<DesktopCommandReceipt, String> {
    invoke_default_bridge("submitPrompt", input.session_id.clone(), &input, data_dir)
}

pub(crate) fn queue_follow_up_in_data_dir(
    input: DesktopPromptCommandInput,
    data_dir: &Path,
) -> Result<DesktopCommandReceipt, String> {
    invoke_default_bridge("queueFollowUp", input.session_id.clone(), &input, data_dir)
}

pub(crate) fn steer_run_in_data_dir(
    input: DesktopPromptCommandInput,
    data_dir: &Path,
) -> Result<DesktopCommandReceipt, String> {
    invoke_default_bridge("steerRun", input.session_id.clone(), &input, data_dir)
}

pub(crate) fn interrupt_run_in_data_dir(
    input: DesktopRunCommandInput,
    data_dir: &Path,
) -> Result<DesktopCommandReceipt, String> {
    invoke_default_bridge("interruptRun", input.session_id.clone(), &input, data_dir)
}

pub(crate) fn resume_run_in_data_dir(
    input: DesktopRunCommandInput,
    data_dir: &Path,
) -> Result<DesktopCommandReceipt, String> {
    invoke_default_bridge("resumeRun", input.session_id.clone(), &input, data_dir)
}

pub(crate) fn decide_approval_in_data_dir(
    input: DesktopApprovalDecisionInput,
    data_dir: &Path,
) -> Result<DesktopCommandReceipt, String> {
    match input.state.as_str() {
        "approved" | "denied" | "expired" | "cancelled" => {}
        _ => {
            return Ok(failed_receipt(input.session_id));
        }
    };
    invoke_default_bridge("decideApproval", input.session_id.clone(), &input, data_dir)
}

fn with_resolved_data_dir(
    session_id: String,
    action: impl FnOnce(&Path) -> Result<DesktopCommandReceipt, String>,
) -> Result<DesktopCommandReceipt, String> {
    match sessions::resolve_data_dir() {
        Ok(data_dir) => action(&data_dir),
        Err(_) => Ok(failed_receipt(session_id)),
    }
}

fn invoke_default_bridge<T: Serialize>(
    action: &'static str,
    session_id: String,
    input: &T,
    data_dir: &Path,
) -> Result<DesktopCommandReceipt, String> {
    let result =
        DesktopCommandBridge::default().and_then(|bridge| bridge.invoke(action, input, data_dir));
    bridge_receipt(session_id, result)
}

fn invoke_default_bridge_json<T: Serialize, R: for<'de> Deserialize<'de>>(
    action: &'static str,
    input: &T,
    data_dir: &Path,
) -> Result<R, String> {
    DesktopCommandBridge::default().and_then(|bridge| bridge.invoke_json(action, input, data_dir))
}

#[cfg(test)]
pub(crate) fn submit_prompt_with_bridge(
    input: DesktopPromptCommandInput,
    data_dir: &Path,
    bridge: &DesktopCommandBridge,
) -> Result<DesktopCommandReceipt, String> {
    bridge_receipt(
        input.session_id.clone(),
        bridge.invoke("submitPrompt", &input, data_dir),
    )
}

#[cfg(test)]
pub(crate) fn decide_approval_with_bridge(
    input: DesktopApprovalDecisionInput,
    data_dir: &Path,
    bridge: &DesktopCommandBridge,
) -> Result<DesktopCommandReceipt, String> {
    bridge_receipt(
        input.session_id.clone(),
        bridge.invoke("decideApproval", &input, data_dir),
    )
}

fn bridge_receipt(
    session_id: String,
    result: Result<DesktopCommandReceipt, String>,
) -> Result<DesktopCommandReceipt, String> {
    match result {
        Ok(receipt) => Ok(receipt),
        Err(_) => Ok(failed_receipt(session_id)),
    }
}

fn failed_receipt(session_id: String) -> DesktopCommandReceipt {
    DesktopCommandReceipt {
        session_id,
        status: "failed".to_owned(),
        events_written: 0,
    }
}
