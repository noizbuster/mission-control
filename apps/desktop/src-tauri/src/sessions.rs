use crate::session_parse::{empty_log, parse_session_contents};
use serde::Serialize;
use serde_json::Value;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{metadata, read_dir, read_to_string};
use std::path::{Path, PathBuf};

const DATA_DIR_ENV: &str = "MCTRL_DATA_DIR";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionLogState {
    Available,
    Empty,
    Missing,
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
    pub diagnostics: Vec<SessionDiagnostic>,
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
    pub diagnostics: Vec<SessionDiagnostic>,
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

type DesktopResult<T> = Result<T, DesktopSessionError>;

pub fn resolve_data_dir() -> DesktopResult<PathBuf> {
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

pub fn list_sessions_in_data_dir(data_dir: &Path) -> DesktopResult<Vec<DesktopSessionSummary>> {
    let sessions_dir = data_dir.join("sessions");
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }
    let entries = read_dir(&sessions_dir).map_err(|error| {
        session_error(format!(
            "could not list sessions in {}: {error}",
            sessions_dir.display()
        ))
    })?;
    let mut summaries = Vec::new();
    for entry_result in entries {
        let entry = entry_result
            .map_err(|error| session_error(format!("could not read session entry: {error}")))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = match path.file_stem().and_then(|value| value.to_str()) {
            Some(value) => value.to_owned(),
            None => continue,
        };
        let log = read_session_events_from_data_dir(data_dir, &session_id)?;
        summaries.push(DesktopSessionSummary {
            session_id,
            file_name: entry.file_name().to_string_lossy().into_owned(),
            state: log.state,
            event_count: log.envelopes.len(),
            diagnostics: log.diagnostics,
        });
    }
    summaries.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    Ok(summaries)
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

pub fn read_session_snapshot_from_data_dir(
    data_dir: &Path,
    session_id: &str,
) -> DesktopResult<DesktopSessionSnapshot> {
    let log = read_session_events_from_data_dir(data_dir, session_id)?;
    let mut graph_ids = Vec::new();
    for envelope in &log.envelopes {
        if let Some(graph_id) = envelope
            .get("event")
            .and_then(|event| event.get("abg"))
            .and_then(|abg| abg.get("graphId"))
            .and_then(Value::as_str)
        {
            if !graph_ids.iter().any(|value| value == graph_id) {
                graph_ids.push(graph_id.to_owned());
            }
        }
    }
    Ok(DesktopSessionSnapshot {
        session_id: log.session_id,
        state: log.state,
        event_count: log.envelopes.len(),
        graph_ids,
        diagnostics: log.diagnostics,
    })
}

fn parse_session_id(session_id: &str) -> DesktopResult<String> {
    if session_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Ok(session_id.to_owned());
    }
    Err(session_error(format!("invalid session id {session_id}")))
}

fn session_path(data_dir: &Path, session_id: &str) -> PathBuf {
    data_dir
        .join("sessions")
        .join(format!("{session_id}.jsonl"))
}

fn session_error(message: impl Into<String>) -> DesktopSessionError {
    DesktopSessionError {
        message: message.into(),
    }
}
