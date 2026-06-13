use crate::session_index::{SessionIndexCatalog, read_session_lock_state};
use crate::session_index_format::SessionIndexSessionRecord;
use crate::session_projection::{project_session_stats, project_session_tree_summary};
use crate::sessions::{
    DesktopResult, DesktopSessionLog, DesktopSessionSnapshot, DesktopSessionSummary,
    SessionDiagnostic, SessionLogState, parse_session_id, read_session_events_from_data_dir,
    session_error,
};
use serde_json::Value;
use std::cmp::Ordering;
use std::fs::read_dir;
use std::path::Path;

pub fn list_sessions_in_data_dir(data_dir: &Path) -> DesktopResult<Vec<DesktopSessionSummary>> {
    let sessions_dir = data_dir.join("sessions");
    let index = SessionIndexCatalog::read(data_dir);
    if !sessions_dir.exists() && index.session_ids().next().is_none() {
        return Ok(Vec::new());
    }
    let mut session_ids = index
        .session_ids()
        .filter(|session_id| parse_session_id(session_id).is_ok())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if sessions_dir.exists() {
        let entries = read_dir(&sessions_dir).map_err(|error| {
            session_error(format!(
                "could not list sessions in {}: {error}",
                sessions_dir.display()
            ))
        })?;
        for entry_result in entries {
            let entry = entry_result
                .map_err(|error| session_error(format!("could not read session entry: {error}")))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if parse_session_id(session_id).is_ok()
                && !session_ids.iter().any(|existing| existing == session_id)
            {
                session_ids.push(session_id.to_owned());
            }
        }
    }
    let mut summaries = Vec::new();
    for session_id in session_ids {
        let log = read_session_events_from_data_dir(data_dir, &session_id)?;
        let session_tree = project_session_tree_summary(&log);
        let stats = project_session_stats(&log);
        let index_record = index.get(&session_id);
        let log_updated_at = session_log_updated_at(&log);
        let fresh_index = index_record
            .filter(|record| is_fresh_index_record(record, &log, log_updated_at.as_deref()));
        let updated_at = projected_updated_at(fresh_index, log_updated_at);
        summaries.push(DesktopSessionSummary {
            file_name: format!("{session_id}.jsonl"),
            event_count: log.envelopes.len(),
            state: log.state,
            lock_state: read_session_lock_state(data_dir, &session_id),
            indexed: fresh_index.is_some(),
            updated_at,
            diagnostics: diagnostics_with_index(
                log.diagnostics,
                index.global_diagnostics(),
                index.diagnostics_for(&session_id),
            ),
            session_tree,
            stats: Some(stats),
            session_id,
        });
    }
    summaries.sort_by(compare_session_summaries);
    Ok(summaries)
}

pub fn read_session_snapshot_from_data_dir(
    data_dir: &Path,
    session_id: &str,
) -> DesktopResult<DesktopSessionSnapshot> {
    let log = read_session_events_from_data_dir(data_dir, session_id)?;
    let index = SessionIndexCatalog::read(data_dir);
    let index_record = index.get(&log.session_id);
    let log_updated_at = session_log_updated_at(&log);
    let fresh_index = index_record
        .filter(|record| is_fresh_index_record(record, &log, log_updated_at.as_deref()));
    let updated_at = projected_updated_at(fresh_index, log_updated_at);
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
    let session_tree = project_session_tree_summary(&log);
    let stats = project_session_stats(&log);
    let snapshot_session_id = log.session_id;
    let diagnostics = diagnostics_with_index(
        log.diagnostics,
        index.global_diagnostics(),
        index.diagnostics_for(&snapshot_session_id),
    );
    Ok(DesktopSessionSnapshot {
        session_id: snapshot_session_id,
        state: log.state,
        event_count: log.envelopes.len(),
        graph_ids,
        lock_state: read_session_lock_state(data_dir, session_id),
        indexed: fresh_index.is_some(),
        updated_at,
        diagnostics,
        session_tree,
        stats: Some(stats),
    })
}

fn is_fresh_index_record(
    record: &SessionIndexSessionRecord,
    log: &DesktopSessionLog,
    updated_at: Option<&str>,
) -> bool {
    if log.state != SessionLogState::Available || record.event_count != log.envelopes.len() {
        return false;
    }
    match updated_at {
        Some(timestamp) => record.updated_at.as_str() >= timestamp,
        None => false,
    }
}

fn projected_updated_at(
    fresh_index: Option<&SessionIndexSessionRecord>,
    log_updated_at: Option<String>,
) -> Option<String> {
    match (fresh_index, log_updated_at) {
        (Some(record), _) => Some(record.updated_at.clone()),
        (None, timestamp) => timestamp,
    }
}

fn session_log_updated_at(log: &DesktopSessionLog) -> Option<String> {
    log.envelopes
        .iter()
        .rev()
        .find_map(|envelope| envelope.get("event")?.get("timestamp")?.as_str())
        .map(str::to_owned)
}

fn diagnostics_with_index(
    mut diagnostics: Vec<SessionDiagnostic>,
    global_diagnostics: &[SessionDiagnostic],
    index_diagnostics: &[SessionDiagnostic],
) -> Vec<SessionDiagnostic> {
    diagnostics.extend(global_diagnostics.iter().cloned());
    diagnostics.extend(index_diagnostics.iter().cloned());
    diagnostics
}

fn compare_session_summaries(
    left: &DesktopSessionSummary,
    right: &DesktopSessionSummary,
) -> Ordering {
    let time_order = right
        .updated_at
        .as_deref()
        .unwrap_or("")
        .cmp(left.updated_at.as_deref().unwrap_or(""));
    if time_order == Ordering::Equal {
        left.session_id.cmp(&right.session_id)
    } else {
        time_order
    }
}
