export const sessionEventStoreSchemaSql = [
    `
            CREATE TABLE IF NOT EXISTS session_event_sequences (
                session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
                next_seq INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS session_events (
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                event_id TEXT NOT NULL,
                type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                run_id TEXT,
                turn_id TEXT,
                causation_id TEXT,
                correlation_id TEXT,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (session_id, seq),
                CONSTRAINT session_events_event_id_unique UNIQUE (event_id)
            );
        `,
    'CREATE INDEX IF NOT EXISTS session_events_session_type_idx ON session_events (session_id, type);',
    'CREATE INDEX IF NOT EXISTS session_events_run_idx ON session_events (run_id);',
] as const;
