export const runtimePersistenceSchemaSql = [
    `
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
        `,
    'CREATE INDEX IF NOT EXISTS sessions_status_listing_idx ON sessions (status, last_activity_at);',
    'CREATE INDEX IF NOT EXISTS sessions_parent_session_idx ON sessions (parent_session_id);',
    'CREATE INDEX IF NOT EXISTS sessions_root_session_idx ON sessions (root_session_id);',
    `
            CREATE TABLE IF NOT EXISTS missions (
                mission_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                workflow_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
        `,
    'CREATE INDEX IF NOT EXISTS missions_status_idx ON missions (status, updated_at);',
    'CREATE INDEX IF NOT EXISTS missions_workflow_idx ON missions (workflow_name);',
    `
            CREATE TABLE IF NOT EXISTS mission_runs (
                run_id TEXT PRIMARY KEY,
                mission_id TEXT NOT NULL,
                parent_run_id TEXT,
                session_id TEXT,
                child_agent_kind TEXT,
                child_agent_id TEXT,
                child_session_ids_json TEXT,
                retry_state_json TEXT,
                status TEXT NOT NULL,
                prompt TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT,
                completed_at TEXT,
                failed_at TEXT,
                cancelled_at TEXT,
                passthrough_json TEXT NOT NULL
            );
        `,
    'CREATE INDEX IF NOT EXISTS mission_runs_mission_status_idx ON mission_runs (mission_id, status);',
    'CREATE INDEX IF NOT EXISTS mission_runs_session_idx ON mission_runs (session_id);',
    'CREATE INDEX IF NOT EXISTS mission_runs_parent_run_idx ON mission_runs (parent_run_id);',
    `
            CREATE TABLE IF NOT EXISTS session_inputs (
                input_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                delivery TEXT NOT NULL,
                status TEXT NOT NULL,
                prompt TEXT NOT NULL,
                admitted_seq INTEGER,
                promoted_seq INTEGER,
                created_at TEXT NOT NULL,
                admitted_at TEXT,
                promoted_at TEXT,
                cancelled_at TEXT,
                metadata_json TEXT
            );
        `,
    'CREATE INDEX IF NOT EXISTS session_inputs_queue_idx ON session_inputs (session_id, status, created_at);',
    'CREATE INDEX IF NOT EXISTS session_inputs_delivery_idx ON session_inputs (delivery, status);',
    `
            CREATE TABLE IF NOT EXISTS session_awaits (
                wait_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                source_kind TEXT NOT NULL,
                source_id TEXT NOT NULL,
                run_id TEXT,
                tool_call_id TEXT,
                approval_id TEXT,
                job_id TEXT,
                child_session_id TEXT,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                resolved_at TEXT,
                cancelled_at TEXT,
                metadata_json TEXT
            );
        `,
    `
            CREATE INDEX IF NOT EXISTS session_awaits_pending_idx
            ON session_awaits (session_id, reason, created_at)
            WHERE status = 'pending';
        `,
    'CREATE INDEX IF NOT EXISTS session_awaits_child_session_idx ON session_awaits (child_session_id);',
    'CREATE INDEX IF NOT EXISTS session_awaits_source_idx ON session_awaits (source_kind, source_id);',
    `
            CREATE TABLE IF NOT EXISTS context_epochs (
                context_epoch_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                epoch INTEGER NOT NULL,
                source_id TEXT NOT NULL,
                baseline_text TEXT,
                update_text TEXT,
                created_at TEXT NOT NULL,
                metadata_json TEXT
            );
        `,
    `
            CREATE UNIQUE INDEX IF NOT EXISTS context_epochs_session_epoch_source_unique
            ON context_epochs (session_id, epoch, source_id);
        `,
    'CREATE INDEX IF NOT EXISTS context_epochs_session_epoch_idx ON context_epochs (session_id, epoch);',
    `
            CREATE TABLE IF NOT EXISTS runtime_db_migration_ledger (
                migration_id TEXT PRIMARY KEY,
                legacy_db_identity TEXT NOT NULL,
                source_root_file_url TEXT NOT NULL,
                source_db_file_url TEXT,
                source_manifest_sha256 TEXT NOT NULL,
                copied_tables_json TEXT NOT NULL,
                legacy_runs_json TEXT NOT NULL,
                completed_at TEXT NOT NULL
            );
        `,
] as const;
