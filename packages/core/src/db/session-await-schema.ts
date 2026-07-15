import { eq } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { sessions } from './session-core-schema';
import {
    sessionAwaitReasons,
    sessionAwaitSourceKinds,
    sessionAwaitStatuses,
    sessionInputDeliveries,
    sessionInputStatuses,
    sessionRelationKinds,
} from './session-schema-literals';

export const sessionAwaits = sqliteTable(
    'session_awaits',
    {
        waitId: text('wait_id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        reason: text('reason', { enum: sessionAwaitReasons }).notNull(),
        sourceKind: text('source_kind', { enum: sessionAwaitSourceKinds }).notNull(),
        sourceId: text('source_id').notNull(),
        runId: text('run_id'),
        toolCallId: text('tool_call_id'),
        approvalId: text('approval_id'),
        jobId: text('job_id'),
        childSessionId: text('child_session_id'),
        status: text('status', { enum: sessionAwaitStatuses }).notNull(),
        createdAt: text('created_at').notNull(),
        resolvedAt: text('resolved_at'),
        cancelledAt: text('cancelled_at'),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        index('session_awaits_pending_idx')
            .on(table.sessionId, table.reason, table.createdAt)
            .where(eq(table.status, 'pending')),
        index('session_awaits_child_session_idx').on(table.childSessionId),
        index('session_awaits_source_idx').on(table.sourceKind, table.sourceId),
    ],
);

export const sessionInputs = sqliteTable(
    'session_inputs',
    {
        inputId: text('input_id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        delivery: text('delivery', { enum: sessionInputDeliveries }).notNull(),
        status: text('status', { enum: sessionInputStatuses }).notNull(),
        prompt: text('prompt').notNull(),
        admittedSeq: integer('admitted_seq'),
        promotedSeq: integer('promoted_seq'),
        createdAt: text('created_at').notNull(),
        admittedAt: text('admitted_at'),
        promotedAt: text('promoted_at'),
        cancelledAt: text('cancelled_at'),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        index('session_inputs_queue_idx').on(table.sessionId, table.status, table.createdAt),
        index('session_inputs_delivery_idx').on(table.delivery, table.status),
    ],
);

export const sessionRelations = sqliteTable(
    'session_relations',
    {
        relationId: text('relation_id').primaryKey(),
        parentSessionId: text('parent_session_id').references(() => sessions.sessionId, {
            onDelete: 'cascade',
        }),
        childSessionId: text('child_session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        kind: text('kind', { enum: sessionRelationKinds }).notNull(),
        createdAt: text('created_at').notNull(),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        index('session_relations_child_session_idx').on(table.childSessionId),
        index('session_relations_parent_session_idx').on(table.parentSessionId),
        unique('session_relations_parent_child_kind_unique').on(
            table.parentSessionId,
            table.childSessionId,
            table.kind,
        ),
    ],
);
