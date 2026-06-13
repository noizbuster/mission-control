pub use crate::session_catalog::{list_sessions_in_data_dir, read_session_snapshot_from_data_dir};
use crate::session_projection::{DesktopSessionStats, DesktopSessionTreeSummary};
use crate::session_parse::{empty_log, parse_session_contents};
use serde::Serialize;
use serde_json::Value;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{metadata, read_to_string};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;

const DATA_DIR_ENV: &str = "MCTRL_DATA_DIR";

#[cfg(test)]
static TEST_DATA_DIR_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionLogState {
    Available,
    Empty,
    Missing,
    Corrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionLockState {
    None,
    Live,
    Stale,
    Corrupt,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiagnostic {
    pub code: String,
    pub message: String,
    pub line_number: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionSummary {
    pub session_id: String,
    pub file_name: String,
    pub state: SessionLogState,
    pub event_count: usize,
    pub lock_state: SessionLockState,
    pub indexed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub diagnostics: Vec<SessionDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_tree: Option<DesktopSessionTreeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<DesktopSessionStats>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionLog {
    pub session_id: String,
    pub state: SessionLogState,
    pub contents: String,
    pub envelopes: Vec<Value>,
    pub diagnostics: Vec<SessionDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionSnapshot {
    pub session_id: String,
    pub state: SessionLogState,
    pub event_count: usize,
    pub graph_ids: Vec<String>,
    pub lock_state: SessionLockState,
    pub indexed: bool,
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

pub fn read_session_events_from_data_dir(
    data_dir: &Path,
    session_id: &str,
) -> DesktopResult<DesktopSessionLog> {
    let parsed_session_id = parse_session_id(session_id)?;
    let path = session_path(data_dir, &parsed_session_id);
    if !path.exists() {
        return Ok(empty_log(parsed_session_id, SessionLogState::Missing));
    }
    if metadata(&path)
        .map_err(|error| session_error(format!("could not inspect {}: {error}", path.display())))?
        .len()
        == 0
    {
        return Ok(empty_log(parsed_session_id, SessionLogState::Empty));
    }
    let contents = read_to_string(&path)
        .map_err(|error| session_error(format!("could not read {}: {error}", path.display())))?;
    Ok(parse_session_contents(&parsed_session_id, contents))
}

pub(crate) fn parse_session_id(session_id: &str) -> DesktopResult<String> {
    if session_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Ok(session_id.to_owned());
    }
    Err(session_error(format!("invalid session id {session_id}")))
}

pub(crate) fn session_path(data_dir: &Path, session_id: &str) -> PathBuf {
    data_dir
        .join("sessions")
        .join(format!("{session_id}.jsonl"))
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
