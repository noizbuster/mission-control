export const agentJobRelationSchemaSql = [
    `
            CREATE TABLE IF NOT EXISTS session_relations (
                relation_id TEXT PRIMARY KEY,
                parent_session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
                child_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                created_at TEXT NOT NULL,
                metadata_json TEXT,
                UNIQUE(parent_session_id, child_session_id, kind)
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS runtime_agents (
                agent_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
                parent_agent_id TEXT,
                status TEXT NOT NULL,
                activity TEXT,
                visibility TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                parked_at TEXT,
                revived_at TEXT,
                metadata_json TEXT
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS async_jobs (
                job_id TEXT PRIMARY KEY,
                parent_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
                child_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
                agent_id TEXT,
                status TEXT NOT NULL,
                queued_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                failed_at TEXT,
                cancelled_at TEXT,
                cancellation_reason TEXT,
                result_json TEXT,
                error_json TEXT,
                metadata_json TEXT
            );
        `,
    'CREATE INDEX IF NOT EXISTS session_relations_child_session_idx ON session_relations (child_session_id);',
    'CREATE INDEX IF NOT EXISTS session_relations_parent_session_idx ON session_relations (parent_session_id);',
    'CREATE INDEX IF NOT EXISTS runtime_agents_session_idx ON runtime_agents (session_id);',
    'CREATE INDEX IF NOT EXISTS runtime_agents_parent_idx ON runtime_agents (parent_agent_id);',
    'CREATE INDEX IF NOT EXISTS runtime_agents_status_idx ON runtime_agents (status, updated_at);',
    'CREATE INDEX IF NOT EXISTS async_jobs_status_idx ON async_jobs (status, queued_at);',
    'CREATE INDEX IF NOT EXISTS async_jobs_parent_session_idx ON async_jobs (parent_session_id);',
    'CREATE INDEX IF NOT EXISTS async_jobs_child_session_idx ON async_jobs (child_session_id);',
    'CREATE INDEX IF NOT EXISTS async_jobs_agent_idx ON async_jobs (agent_id);',
] as const;
