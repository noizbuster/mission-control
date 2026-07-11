export const sessionControlSchemaSql = [
    `
        CREATE TABLE IF NOT EXISTS session_control_leases (
            db_identity TEXT NOT NULL,
            session_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            epoch INTEGER NOT NULL,
            nonce_hash TEXT NOT NULL,
            pid INTEGER NOT NULL,
            process_start_id TEXT NOT NULL,
            heartbeat_wall_ms INTEGER NOT NULL,
            expires_wall_ms INTEGER NOT NULL,
            PRIMARY KEY (db_identity, session_id)
        );
    `,
    `
        CREATE TABLE IF NOT EXISTS session_control_operations (
            db_identity TEXT NOT NULL,
            session_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            owner_epoch INTEGER NOT NULL,
            barrier_kind TEXT NOT NULL CHECK (barrier_kind IN ('all_mutations', 'child_spawn_only')),
            status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'timed_out')),
            deadline_wall_ms INTEGER NOT NULL,
            receipt_json TEXT,
            captured_handle_ids_json TEXT NOT NULL CHECK (json_valid(captured_handle_ids_json)),
            settled_handle_ids_json TEXT NOT NULL CHECK (json_valid(settled_handle_ids_json)),
            barrier_released_at INTEGER,
            created_at INTEGER NOT NULL,
            terminal_at INTEGER,
            retention_until INTEGER NOT NULL,
            PRIMARY KEY (db_identity, session_id, operation_id)
        );
    `,
    `
        CREATE INDEX IF NOT EXISTS session_control_operations_retention_idx
        ON session_control_operations (retention_until, status);
    `,
    `
        CREATE TRIGGER IF NOT EXISTS session_control_operations_terminal_status_immutable
        BEFORE UPDATE OF status ON session_control_operations
        WHEN OLD.status <> 'active' AND NEW.status <> OLD.status
        BEGIN
            SELECT RAISE(ABORT, 'session control operation terminal status is immutable');
        END;
    `,
    `
        CREATE TABLE IF NOT EXISTS session_control_late_settlements (
            late_id TEXT PRIMARY KEY,
            db_identity TEXT NOT NULL,
            session_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            owner_epoch INTEGER NOT NULL,
            handle_kind TEXT NOT NULL,
            handle_id TEXT NOT NULL,
            attempted_event_type TEXT NOT NULL,
            observed_at INTEGER NOT NULL,
            metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
        );
    `,
    `
        CREATE INDEX IF NOT EXISTS session_control_late_settlements_observed_idx
        ON session_control_late_settlements (observed_at);
    `,
] as const;
