use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;
#[cfg(test)]
use std::sync::Mutex;

const DATA_DIR_ENV: &str = "MCTRL_DATA_DIR";

#[cfg(test)]
static TEST_DATA_DIR_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionLogState {
    Available,
    Empty,
    Missing,
    Corrupt,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceTrustState {
    Trusted,
    Denied,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiagnostic {
    pub code: String,
    pub message: String,
    pub line_number: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionTreeSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_trust: Option<WorkspaceTrustState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_leaf_id: Option<String>,
    pub entry_count: usize,
    pub branch_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_source_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone_source_session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionStats {
    pub event_count: usize,
    pub pending_approval_count: usize,
    pub blocked_run_count: usize,
    pub command_event_count: usize,
    pub diff_event_count: usize,
    pub tool_outcome_count: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionSummary {
    pub session_id: String,
    pub file_name: String,
    pub state: SessionLogState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub awaiting: Option<Value>,
    pub event_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub diagnostics: Vec<SessionDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_tree: Option<DesktopSessionTreeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<DesktopSessionStats>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionLog {
    pub session_id: String,
    pub state: SessionLogState,
    pub contents: String,
    pub envelopes: Vec<Value>,
    pub diagnostics: Vec<SessionDiagnostic>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionSnapshot {
    pub session_id: String,
    pub state: SessionLogState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub awaiting: Option<Value>,
    pub event_count: usize,
    pub graph_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub diagnostics: Vec<SessionDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_tree: Option<DesktopSessionTreeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<DesktopSessionStats>,
}

#[derive(Debug)]
pub struct DesktopSessionError {
    message: String,
}

impl Display for DesktopSessionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for DesktopSessionError {}

pub(crate) type DesktopResult<T> = Result<T, DesktopSessionError>;

pub fn resolve_data_dir() -> DesktopResult<PathBuf> {
    #[cfg(test)]
    if let Some(data_dir) = test_data_dir_override() {
        return Ok(data_dir);
    }
    if let Some(value) = std::env::var_os(DATA_DIR_ENV) {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| session_error("HOME is required when MCTRL_DATA_DIR is not set"))?;
    Ok(home.join(".local").join("share").join("mission-control"))
}

pub(crate) fn session_error(message: impl Into<String>) -> DesktopSessionError {
    DesktopSessionError {
        message: message.into(),
    }
}

#[cfg(test)]
pub(crate) struct TestDataDirOverride {
    previous: Option<PathBuf>,
}

#[cfg(test)]
impl Drop for TestDataDirOverride {
    fn drop(&mut self) {
        if let Ok(mut override_dir) = TEST_DATA_DIR_OVERRIDE.lock() {
            *override_dir = self.previous.take();
        }
    }
}

#[cfg(test)]
pub(crate) fn override_data_dir_for_test(data_dir: PathBuf) -> DesktopResult<TestDataDirOverride> {
    let mut override_dir = TEST_DATA_DIR_OVERRIDE
        .lock()
        .map_err(|_| session_error("test data directory override lock is poisoned"))?;
    let previous = override_dir.replace(data_dir);
    Ok(TestDataDirOverride { previous })
}

#[cfg(test)]
fn test_data_dir_override() -> Option<PathBuf> {
    TEST_DATA_DIR_OVERRIDE
        .lock()
        .map(|override_dir| override_dir.clone())
        .unwrap_or(None)
}
