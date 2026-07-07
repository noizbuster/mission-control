export const createPublicSessionsSql = `
    CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        root_session_id TEXT,
        parent_session_id TEXT,
        status TEXT NOT NULL,
        awaiting_reason TEXT,
        primary_wait_id TEXT,
        workspace_path TEXT,
        provider_id TEXT,
        model_id TEXT,
        title TEXT,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd TEXT,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        stopped_at TEXT,
        failed_at TEXT,
        legacy_jsonl_path TEXT,
        imported_at TEXT,
        exported_at TEXT,
        metadata_json TEXT
    );
`;

export const createRuntimeAgentsSql = `
    CREATE TABLE IF NOT EXISTS runtime_agents (
        agent_id        TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        session_id      TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        parent_agent_id TEXT,
        status          TEXT NOT NULL,
        activity        TEXT,
        visibility      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        parked_at       TEXT,
        revived_at      TEXT,
        metadata_json   TEXT
    );
`;

export const createAsyncJobsSql = `
    CREATE TABLE IF NOT EXISTS async_jobs (
        job_id              TEXT PRIMARY KEY,
        parent_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        child_session_id    TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        agent_id            TEXT,
        status              TEXT NOT NULL,
        queued_at           TEXT NOT NULL,
        started_at          TEXT,
        completed_at        TEXT,
        failed_at           TEXT,
        cancelled_at        TEXT,
        cancellation_reason TEXT,
        result_json         TEXT,
        error_json          TEXT,
        metadata_json       TEXT
    );
`;

export const createSessionAwaitsSql = `
    CREATE TABLE IF NOT EXISTS session_awaits (
        wait_id          TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        reason           TEXT NOT NULL,
        source_kind      TEXT NOT NULL,
        source_id        TEXT NOT NULL,
        run_id           TEXT,
        tool_call_id     TEXT,
        approval_id      TEXT,
        job_id           TEXT,
        child_session_id TEXT,
        status           TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        resolved_at      TEXT,
        cancelled_at     TEXT,
        metadata_json    TEXT
    );
`;

export const createSessionRelationsSql = `
    CREATE TABLE IF NOT EXISTS session_relations (
        relation_id       TEXT PRIMARY KEY,
        parent_session_id TEXT,
        child_session_id  TEXT NOT NULL,
        kind              TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        metadata_json     TEXT,
        UNIQUE(parent_session_id, child_session_id, kind)
    );
`;

export const createAgentJobIndexesSql = [
    'CREATE INDEX IF NOT EXISTS session_relations_child_session_idx ON session_relations (child_session_id)',
    'CREATE INDEX IF NOT EXISTS session_relations_parent_session_idx ON session_relations (parent_session_id)',
    'CREATE INDEX IF NOT EXISTS runtime_agents_session_idx ON runtime_agents (session_id)',
    'CREATE INDEX IF NOT EXISTS runtime_agents_parent_idx ON runtime_agents (parent_agent_id)',
    'CREATE INDEX IF NOT EXISTS runtime_agents_status_idx ON runtime_agents (status, updated_at)',
    'CREATE INDEX IF NOT EXISTS async_jobs_status_idx ON async_jobs (status, queued_at)',
    'CREATE INDEX IF NOT EXISTS async_jobs_parent_session_idx ON async_jobs (parent_session_id)',
    'CREATE INDEX IF NOT EXISTS async_jobs_child_session_idx ON async_jobs (child_session_id)',
    'CREATE INDEX IF NOT EXISTS async_jobs_agent_idx ON async_jobs (agent_id)',
    'CREATE INDEX IF NOT EXISTS session_awaits_pending_idx ON session_awaits (session_id, reason, created_at)',
    'CREATE INDEX IF NOT EXISTS session_awaits_child_session_idx ON session_awaits (child_session_id)',
    'CREATE INDEX IF NOT EXISTS session_awaits_source_idx ON session_awaits (source_kind, source_id)',
] as const;
