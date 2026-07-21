import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { sessionLifecycleStatuses } from './session-schema-literals';

export const sessions = sqliteTable(
    'sessions',
    {
        sessionId: text('session_id').primaryKey(),
        rootSessionId: text('root_session_id'),
        parentSessionId: text('parent_session_id'),
        status: text('status', { enum: sessionLifecycleStatuses }).notNull(),
        awaitingReason: text('awaiting_reason'),
        primaryWaitId: text('primary_wait_id'),
        workspacePath: text('workspace_path'),
        providerId: text('provider_id'),
        modelId: text('model_id'),
        title: text('title'),
        category: text('category'),
        agentName: text('agent_name'),
        totalInputTokens: integer('total_input_tokens').notNull().default(0),
        totalOutputTokens: integer('total_output_tokens').notNull().default(0),
        totalCostUsd: text('total_cost_usd'),
        lastEventSeq: integer('last_event_seq').notNull().default(0),
        createdAt: text('created_at').notNull(),
        updatedAt: text('updated_at').notNull(),
        lastActivityAt: text('last_activity_at').notNull(),
        stoppedAt: text('stopped_at'),
        failedAt: text('failed_at'),
        legacyJsonlPath: text('legacy_jsonl_path'),
        importedAt: text('imported_at'),
        exportedAt: text('exported_at'),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        index('sessions_status_listing_idx').on(table.status, table.lastActivityAt),
        index('sessions_parent_session_idx').on(table.parentSessionId),
        index('sessions_root_session_idx').on(table.rootSessionId),
    ],
);

export const sessionEventSequences = sqliteTable('session_event_sequences', {
    sessionId: text('session_id')
        .primaryKey()
        .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    nextSeq: integer('next_seq').notNull().default(1),
    updatedAt: text('updated_at').notNull(),
});

export const sessionEvents = sqliteTable(
    'session_events',
    {
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        seq: integer('seq').notNull(),
        eventId: text('event_id').notNull(),
        type: text('type').notNull(),
        timestamp: text('timestamp').notNull(),
        runId: text('run_id'),
        turnId: text('turn_id'),
        causationId: text('causation_id'),
        correlationId: text('correlation_id'),
        payloadJson: text('payload_json').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.seq] }),
        unique('session_events_event_id_unique').on(table.eventId),
        index('session_events_session_type_idx').on(table.sessionId, table.type),
        index('session_events_run_idx').on(table.runId),
    ],
);
