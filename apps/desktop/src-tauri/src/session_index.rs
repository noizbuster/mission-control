use crate::session_datetime::is_rfc3339_utc_millis;
use crate::session_index_format::{
    SessionIndexDiagnosticRecord, SessionIndexRecord, SessionIndexSessionRecord,
    parse_session_index_file,
};
use crate::sessions::{SessionDiagnostic, SessionLockState};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::read_to_string;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const LOCK_STALE_AFTER_MS: u128 = 30_000;
const COMMON_MONTH_DAYS: [u32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

#[derive(Debug, Default)]
pub(crate) struct SessionIndexCatalog {
    sessions: HashMap<String, SessionIndexSessionRecord>,
    global_diagnostics: Vec<SessionDiagnostic>,
    diagnostics_by_session: HashMap<String, Vec<SessionDiagnostic>>,
}

impl SessionIndexCatalog {
    pub(crate) fn read(data_dir: &Path) -> Self {
        let contents = match read_to_string(data_dir.join("session-index.json")) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(_) => {
                return Self {
                    sessions: HashMap::new(),
                    global_diagnostics: vec![corrupt_index_diagnostic()],
                    diagnostics_by_session: HashMap::new(),
                };
            }
        };
        let file = match parse_session_index_file(&contents) {
            Ok(file) => file,
            Err(()) => {
                return Self {
                    sessions: HashMap::new(),
                    global_diagnostics: vec![corrupt_index_diagnostic()],
                    diagnostics_by_session: HashMap::new(),
                };
            }
        };
        let mut diagnostics_by_session = HashMap::new();
        for record in file.diagnostics {
            let (session_id, diagnostic) = session_index_diagnostic(record);
            diagnostics_by_session
                .entry(session_id)
                .or_insert_with(Vec::new)
                .push(diagnostic);
        }
        let mut sessions = HashMap::new();
        for record in file.records.into_iter().filter_map(session_record) {
            if is_rfc3339_utc_millis(&record.updated_at) {
                sessions.insert(record.session_id.clone(), record);
            } else {
                diagnostics_by_session
                    .entry(record.session_id)
                    .or_insert_with(Vec::new)
                    .push(corrupt_index_record_diagnostic());
            }
        }
        Self {
            sessions,
            global_diagnostics: Vec::new(),
            diagnostics_by_session,
        }
    }

    pub(crate) fn session_ids(&self) -> impl Iterator<Item = &str> {
        self.sessions.keys().map(String::as_str)
    }

    pub(crate) fn get(&self, session_id: &str) -> Option<&SessionIndexSessionRecord> {
        self.sessions.get(session_id)
    }

    pub(crate) fn global_diagnostics(&self) -> &[SessionDiagnostic] {
        &self.global_diagnostics
    }

    pub(crate) fn diagnostics_for(&self, session_id: &str) -> &[SessionDiagnostic] {
        self.diagnostics_by_session
            .get(session_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLockMetadata {
    session_id: String,
    created_at: String,
    updated_at: Option<String>,
    heartbeat_at: Option<String>,
}

pub(crate) fn read_session_lock_state(data_dir: &Path, session_id: &str) -> SessionLockState {
    let lock_path = data_dir.join("sessions").join(format!("{session_id}.lock"));
    let contents = match read_to_string(&lock_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return SessionLockState::None;
        }
        Err(_) => return SessionLockState::Corrupt,
    };
    let lock = match serde_json::from_str::<SessionLockMetadata>(&contents) {
        Ok(lock) if lock.session_id == session_id => lock,
        _ => return SessionLockState::Corrupt,
    };
    let timestamp = lock
        .heartbeat_at
        .as_deref()
        .or(lock.updated_at.as_deref())
        .unwrap_or(lock.created_at.as_str());
    match is_stale_timestamp(timestamp) {
        Some(true) => SessionLockState::Stale,
        Some(false) => SessionLockState::Live,
        None => SessionLockState::Corrupt,
    }
}

fn session_record(record: SessionIndexRecord) -> Option<SessionIndexSessionRecord> {
    match record {
        SessionIndexRecord::Session(record) => Some(record),
        SessionIndexRecord::Other => None,
    }
}

fn corrupt_index_diagnostic() -> SessionDiagnostic {
    SessionDiagnostic {
        code: "corrupt_index".to_owned(),
        message: "session index could not be read".to_owned(),
        line_number: None,
    }
}

fn corrupt_index_record_diagnostic() -> SessionDiagnostic {
    SessionDiagnostic {
        code: "corrupt_index".to_owned(),
        message: "session index record has an invalid updatedAt".to_owned(),
        line_number: None,
    }
}

fn session_index_diagnostic(record: SessionIndexDiagnosticRecord) -> (String, SessionDiagnostic) {
    (
        record.session_id,
        SessionDiagnostic {
            code: "index_diagnostic".to_owned(),
            message: "session index contains a diagnostic record".to_owned(),
            line_number: record.line_number,
        },
    )
}

fn is_stale_timestamp(value: &str) -> Option<bool> {
    let previous = rfc3339_utc_millis_to_epoch_ms(value)?;
    let now = i128::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis(),
    )
    .ok()?;
    Some(now - previous >= i128::try_from(LOCK_STALE_AFTER_MS).ok()?)
}

fn rfc3339_utc_millis_to_epoch_ms(value: &str) -> Option<i128> {
    if !is_rfc3339_utc_millis(value) {
        return None;
    }
    let year = field(value, 0, 4)?;
    let month = field(value, 5, 7)?;
    let day = field(value, 8, 10)?;
    let hour = field(value, 11, 13)?;
    let minute = field(value, 14, 16)?;
    let second = field(value, 17, 19)?;
    let millis = field(value, 20, 23)?;
    let month_index = usize::try_from(month.checked_sub(1)?).ok()?;
    let leap_day = if month > 2 && is_leap_year(year) {
        1
    } else {
        0
    };
    let days = days_before_year(year) - days_before_year(1970)
        + i128::from(*COMMON_MONTH_DAYS.get(month_index)?)
        + i128::from(leap_day)
        + i128::from(day.checked_sub(1)?);
    Some(
        (((days * 24 + i128::from(hour)) * 60 + i128::from(minute)) * 60 + i128::from(second))
            * 1_000
            + i128::from(millis),
    )
}

fn days_before_year(year: u32) -> i128 {
    let previous = i128::from(year) - 1;
    previous * 365 + previous / 4 - previous / 100 + previous / 400
}

fn is_leap_year(year: u32) -> bool {
    year % 400 == 0 || (year % 4 == 0 && year % 100 != 0)
}

fn field(value: &str, start: usize, end: usize) -> Option<u32> {
    value.get(start..end)?.parse::<u32>().ok()
}
