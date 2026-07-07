export const sessionProjectionSchemaSql = [
    `
            CREATE TABLE IF NOT EXISTS session_messages (
                message_id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                role TEXT NOT NULL,
                provider_message_id TEXT,
                created_at TEXT NOT NULL,
                metadata_json TEXT,
                UNIQUE(session_id, seq)
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS session_parts (
                part_id TEXT PRIMARY KEY NOT NULL,
                message_id TEXT NOT NULL REFERENCES session_messages(message_id) ON DELETE CASCADE,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                part_index INTEGER NOT NULL,
                kind TEXT NOT NULL,
                text TEXT,
                payload_json TEXT,
                created_at TEXT NOT NULL,
                UNIQUE(message_id, part_index)
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS approvals (
                approval_id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                run_id TEXT,
                tool_call_id TEXT,
                status TEXT NOT NULL,
                subject_kind TEXT NOT NULL,
                subject_id TEXT NOT NULL,
                requested_at TEXT NOT NULL,
                decided_at TEXT,
                decision_json TEXT,
                metadata_json TEXT
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS tool_calls (
                tool_call_id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                run_id TEXT,
                approval_id TEXT,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                arguments_json TEXT,
                result_json TEXT,
                started_at TEXT,
                completed_at TEXT,
                failed_at TEXT,
                last_message TEXT,
                error_json TEXT,
                applied_files_json TEXT
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS provider_failures (
                failure_id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                event_id TEXT NOT NULL,
                request_id TEXT,
                provider_turn_id TEXT,
                provider_id TEXT,
                timestamp TEXT NOT NULL,
                error_json TEXT NOT NULL,
                UNIQUE(session_id, event_id)
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS legacy_session_imports (
                import_id TEXT PRIMARY KEY NOT NULL,
                source_path TEXT NOT NULL,
                source_kind TEXT NOT NULL,
                checksum TEXT NOT NULL,
                imported_event_count INTEGER NOT NULL DEFAULT 0,
                imported_at TEXT NOT NULL,
                diagnostics_json TEXT,
                UNIQUE(source_path, checksum)
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS session_index_runs (
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
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
                PRIMARY KEY (session_id, event_id)
            );
        `,
    `
            CREATE TABLE IF NOT EXISTS session_index_diagnostics (
                session_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                code TEXT NOT NULL,
                message TEXT NOT NULL,
                line_number INTEGER,
                PRIMARY KEY (session_id, file_path, code, message)
            );
        `,
    'CREATE INDEX IF NOT EXISTS session_messages_session_idx ON session_messages (session_id, seq);',
    'CREATE INDEX IF NOT EXISTS session_parts_session_idx ON session_parts (session_id, message_id);',
    'CREATE INDEX IF NOT EXISTS approvals_session_status_idx ON approvals (session_id, status);',
    'CREATE INDEX IF NOT EXISTS approvals_subject_idx ON approvals (subject_kind, subject_id);',
    'CREATE INDEX IF NOT EXISTS tool_calls_session_status_idx ON tool_calls (session_id, status);',
    'CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls (run_id);',
    'CREATE INDEX IF NOT EXISTS tool_calls_approval_idx ON tool_calls (approval_id);',
    'CREATE INDEX IF NOT EXISTS provider_failures_request_idx ON provider_failures (session_id, request_id);',
    'CREATE INDEX IF NOT EXISTS legacy_session_imports_source_idx ON legacy_session_imports (source_path);',
    'CREATE INDEX IF NOT EXISTS session_index_runs_by_sequence ON session_index_runs (session_id, sequence);',
] as const;
