-- SQLite-ready derived session index schema.
-- JSONL session logs remain authoritative; these tables are rebuildable projections.
-- No SQLite adapter is enabled in this wave because no SQLite dependency was approved.

CREATE TABLE IF NOT EXISTS session_index_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    event_count INTEGER NOT NULL,
    last_sequence INTEGER,
    last_event_id TEXT,
    last_event_type TEXT,
    updated_at TEXT NOT NULL,
    source_file_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_index_runs (
    session_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    command TEXT,
    state TEXT,
    run_id TEXT,
    input_id TEXT,
    provider_turn_id TEXT,
    reason TEXT,
    error_code TEXT,
    PRIMARY KEY (session_id, event_id),
    FOREIGN KEY (session_id) REFERENCES session_index_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_index_approvals (
    session_id TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    state TEXT NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, approval_id),
    FOREIGN KEY (session_id) REFERENCES session_index_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_index_tools (
    session_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    last_message TEXT,
    result_json TEXT,
    applied_files_json TEXT,
    PRIMARY KEY (session_id, tool_id),
    FOREIGN KEY (session_id) REFERENCES session_index_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_index_provider_failures (
    session_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    request_id TEXT NOT NULL,
    provider_turn_id TEXT,
    error_json TEXT NOT NULL,
    PRIMARY KEY (session_id, event_id),
    FOREIGN KEY (session_id) REFERENCES session_index_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_index_diagnostics (
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    line_number INTEGER,
    PRIMARY KEY (session_id, file_path, code, message)
);

CREATE INDEX IF NOT EXISTS session_index_runs_by_run_id
    ON session_index_runs(session_id, run_id);

CREATE INDEX IF NOT EXISTS session_index_tools_by_status
    ON session_index_tools(session_id, status);

CREATE INDEX IF NOT EXISTS session_index_provider_failures_by_request
    ON session_index_provider_failures(session_id, request_id);
