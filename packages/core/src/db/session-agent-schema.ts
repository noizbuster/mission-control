import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './session-core-schema.js';
import { asyncJobStatuses, runtimeAgentStatuses } from './session-schema-literals.js';

export const runtimeAgents = sqliteTable(
    'runtime_agents',
    {
        agentId: text('agent_id').primaryKey(),
        kind: text('kind').notNull(),
        sessionId: text('session_id').references(() => sessions.sessionId, { onDelete: 'set null' }),
        parentAgentId: text('parent_agent_id'),
        status: text('status', { enum: runtimeAgentStatuses }).notNull(),
        activity: text('activity'),
        visibility: text('visibility'),
        createdAt: text('created_at').notNull(),
        updatedAt: text('updated_at').notNull(),
        parkedAt: text('parked_at'),
        revivedAt: text('revived_at'),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        index('runtime_agents_session_idx').on(table.sessionId),
        index('runtime_agents_parent_idx').on(table.parentAgentId),
        index('runtime_agents_status_idx').on(table.status, table.updatedAt),
    ],
);

export const asyncJobs = sqliteTable(
    'async_jobs',
    {
        jobId: text('job_id').primaryKey(),
        parentSessionId: text('parent_session_id').references(() => sessions.sessionId, {
            onDelete: 'set null',
        }),
        childSessionId: text('child_session_id').references(() => sessions.sessionId, {
            onDelete: 'set null',
        }),
        agentId: text('agent_id'),
        status: text('status', { enum: asyncJobStatuses }).notNull(),
        queuedAt: text('queued_at').notNull(),
        startedAt: text('started_at'),
        completedAt: text('completed_at'),
        failedAt: text('failed_at'),
        cancelledAt: text('cancelled_at'),
        cancellationReason: text('cancellation_reason'),
        resultJson: text('result_json'),
        errorJson: text('error_json'),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        index('async_jobs_status_idx').on(table.status, table.queuedAt),
        index('async_jobs_parent_session_idx').on(table.parentSessionId),
        index('async_jobs_child_session_idx').on(table.childSessionId),
        index('async_jobs_agent_idx').on(table.agentId),
    ],
);
