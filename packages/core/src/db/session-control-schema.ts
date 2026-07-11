import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessionControlLeases = sqliteTable(
    'session_control_leases',
    {
        dbIdentity: text('db_identity').notNull(),
        sessionId: text('session_id').notNull(),
        ownerId: text('owner_id').notNull(),
        epoch: integer('epoch').notNull(),
        nonceHash: text('nonce_hash').notNull(),
        pid: integer('pid').notNull(),
        processStartId: text('process_start_id').notNull(),
        heartbeatWallMs: integer('heartbeat_wall_ms').notNull(),
        expiresWallMs: integer('expires_wall_ms').notNull(),
    },
    (table) => [primaryKey({ columns: [table.dbIdentity, table.sessionId] })],
);

export const sessionControlOperations = sqliteTable(
    'session_control_operations',
    {
        dbIdentity: text('db_identity').notNull(),
        sessionId: text('session_id').notNull(),
        operationId: text('operation_id').notNull(),
        ownerId: text('owner_id').notNull(),
        ownerEpoch: integer('owner_epoch').notNull(),
        barrierKind: text('barrier_kind').notNull(),
        status: text('status').notNull(),
        deadlineWallMs: integer('deadline_wall_ms').notNull(),
        receiptJson: text('receipt_json'),
        capturedHandleIdsJson: text('captured_handle_ids_json').notNull(),
        settledHandleIdsJson: text('settled_handle_ids_json').notNull(),
        barrierReleasedAt: integer('barrier_released_at'),
        createdAt: integer('created_at').notNull(),
        terminalAt: integer('terminal_at'),
        retentionUntil: integer('retention_until').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.dbIdentity, table.sessionId, table.operationId] }),
        index('session_control_operations_retention_idx').on(table.retentionUntil, table.status),
    ],
);

export const sessionControlLateSettlements = sqliteTable(
    'session_control_late_settlements',
    {
        lateId: text('late_id').primaryKey(),
        dbIdentity: text('db_identity').notNull(),
        sessionId: text('session_id').notNull(),
        operationId: text('operation_id').notNull(),
        ownerEpoch: integer('owner_epoch').notNull(),
        handleKind: text('handle_kind').notNull(),
        handleId: text('handle_id').notNull(),
        attemptedEventType: text('attempted_event_type').notNull(),
        observedAt: integer('observed_at').notNull(),
        metadataJson: text('metadata_json').notNull(),
    },
    (table) => [index('session_control_late_settlements_observed_idx').on(table.observedAt)],
);
