import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { sessions } from './session-core-schema';
import {
    approvalStatuses,
    missionRunStatuses,
    sessionMessageRoles,
    sessionPartKinds,
    toolCallStatuses,
} from './session-schema-literals';

export const missions = sqliteTable(
    'missions',
    {
        missionId: text('mission_id').primaryKey(),
        status: text('status').notNull(),
        workflowName: text('workflow_name'),
        createdAt: text('created_at').notNull(),
        updatedAt: text('updated_at').notNull(),
        payloadJson: text('payload_json').notNull(),
    },
    (table) => [
        index('missions_status_idx').on(table.status, table.updatedAt),
        index('missions_workflow_idx').on(table.workflowName),
    ],
);

export const sessionMessages = sqliteTable(
    'session_messages',
    {
        messageId: text('message_id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        seq: integer('seq').notNull(),
        role: text('role', { enum: sessionMessageRoles }).notNull(),
        providerMessageId: text('provider_message_id'),
        createdAt: text('created_at').notNull(),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        unique('session_messages_session_seq_unique').on(table.sessionId, table.seq),
        index('session_messages_session_idx').on(table.sessionId, table.seq),
    ],
);

export const sessionParts = sqliteTable(
    'session_parts',
    {
        partId: text('part_id').primaryKey(),
        messageId: text('message_id')
            .notNull()
            .references(() => sessionMessages.messageId, { onDelete: 'cascade' }),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        partIndex: integer('part_index').notNull(),
        kind: text('kind', { enum: sessionPartKinds }).notNull(),
        text: text('text'),
        payloadJson: text('payload_json'),
        createdAt: text('created_at').notNull(),
    },
    (table) => [
        unique('session_parts_message_index_unique').on(table.messageId, table.partIndex),
        index('session_parts_session_idx').on(table.sessionId, table.messageId),
    ],
);

export const missionRuns = sqliteTable(
    'mission_runs',
    {
        runId: text('run_id').primaryKey(),
        missionId: text('mission_id').notNull(),
        parentRunId: text('parent_run_id'),
        sessionId: text('session_id').references(() => sessions.sessionId, { onDelete: 'set null' }),
        childAgentKind: text('child_agent_kind'),
        childAgentId: text('child_agent_id'),
        childSessionIdsJson: text('child_session_ids_json'),
        retryStateJson: text('retry_state_json'),
        status: text('status', { enum: missionRunStatuses }).notNull(),
        prompt: text('prompt'),
        createdAt: text('created_at').notNull(),
        updatedAt: text('updated_at').notNull(),
        startedAt: text('started_at'),
        endedAt: text('ended_at'),
        completedAt: text('completed_at'),
        failedAt: text('failed_at'),
        cancelledAt: text('cancelled_at'),
        passthroughJson: text('passthrough_json'),
    },
    (table) => [
        index('mission_runs_mission_status_idx').on(table.missionId, table.status),
        index('mission_runs_session_idx').on(table.sessionId),
        index('mission_runs_parent_run_idx').on(table.parentRunId),
    ],
);

export const approvals = sqliteTable(
    'approvals',
    {
        approvalId: text('approval_id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        runId: text('run_id'),
        toolCallId: text('tool_call_id'),
        status: text('status', { enum: approvalStatuses }).notNull(),
        subjectKind: text('subject_kind').notNull(),
        subjectId: text('subject_id').notNull(),
        requestedAt: text('requested_at').notNull(),
        decidedAt: text('decided_at'),
        decisionJson: text('decision_json'),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        index('approvals_session_status_idx').on(table.sessionId, table.status),
        index('approvals_subject_idx').on(table.subjectKind, table.subjectId),
    ],
);

export const toolCalls = sqliteTable(
    'tool_calls',
    {
        toolCallId: text('tool_call_id').notNull(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        runId: text('run_id'),
        approvalId: text('approval_id'),
        name: text('name').notNull(),
        status: text('status', { enum: toolCallStatuses }).notNull(),
        argumentsJson: text('arguments_json'),
        resultJson: text('result_json'),
        startedAt: text('started_at'),
        completedAt: text('completed_at'),
        failedAt: text('failed_at'),
        lastMessage: text('last_message'),
        errorJson: text('error_json'),
        appliedFilesJson: text('applied_files_json'),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.toolCallId] }),
        index('tool_calls_session_status_idx').on(table.sessionId, table.status),
        index('tool_calls_run_idx').on(table.runId),
        index('tool_calls_approval_idx').on(table.approvalId),
    ],
);


export const providerFailures = sqliteTable(
    'provider_failures',
    {
        failureId: text('failure_id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        eventId: text('event_id').notNull(),
        requestId: text('request_id'),
        providerTurnId: text('provider_turn_id'),
        providerId: text('provider_id'),
        timestamp: text('timestamp').notNull(),
        errorJson: text('error_json').notNull(),
    },
    (table) => [
        unique('provider_failures_session_event_unique').on(table.sessionId, table.eventId),
        index('provider_failures_request_idx').on(table.sessionId, table.requestId),
    ],
);

export const contextEpochs = sqliteTable(
    'context_epochs',
    {
        contextEpochId: text('context_epoch_id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        epoch: integer('epoch').notNull(),
        sourceId: text('source_id').notNull(),
        baselineText: text('baseline_text'),
        updateText: text('update_text'),
        createdAt: text('created_at').notNull(),
        metadataJson: text('metadata_json'),
    },
    (table) => [
        unique('context_epochs_session_epoch_source_unique').on(table.sessionId, table.epoch, table.sourceId),
        index('context_epochs_session_epoch_idx').on(table.sessionId, table.epoch),
    ],
);


export const desktopToolProposals = sqliteTable(
    'desktop_tool_proposals',
    {
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        toolCallId: text('tool_call_id').notNull(),
        toolName: text('tool_name').notNull(),
        argumentsJson: text('arguments_json').notNull(),
        createdAt: text('created_at').notNull(),
        conflicted: integer('conflicted').notNull().default(0),
    },
    (table) => [primaryKey({ columns: [table.sessionId, table.toolCallId] })],
);

export const desktopApprovalEffects = sqliteTable(
    'desktop_approval_effects',
    {
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        approvalId: text('approval_id').notNull(),
        runId: text('run_id').notNull(),
        toolCallId: text('tool_call_id').notNull(),
        toolName: text('tool_name').notNull(),
        argumentsJson: text('arguments_json').notNull(),
        workspaceRoot: text('workspace_root').notNull(),
        state: text('state').notNull(),
        executionToken: text('execution_token'),
        leaseExpiresAt: text('lease_expires_at'),
        outcome: text('outcome'),
        requestedAt: text('requested_at').notNull(),
        executingAt: text('executing_at'),
        settledAt: text('settled_at'),
        unknownAt: text('unknown_at'),
        resolvedAt: text('resolved_at'),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.approvalId] }),
        index('desktop_approval_effects_state_idx').on(table.state),
    ],
);

export const sessionProjectionRuns = sqliteTable(
    'session_projection_runs',
    {
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.sessionId, { onDelete: 'cascade' }),
        eventId: text('event_id').notNull(),
        sequence: integer('sequence').notNull(),
        timestamp: text('timestamp').notNull(),
        eventType: text('event_type').notNull(),
        command: text('command'),
        state: text('state'),
        runId: text('run_id'),
        inputId: text('input_id'),
        providerTurnId: text('provider_turn_id'),
        reason: text('reason'),
        errorCode: text('error_code'),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.eventId] }),
        index('session_projection_runs_by_sequence').on(table.sessionId, table.sequence),
    ],
);

export const sessionProjectionDiagnostics = sqliteTable(
    'session_projection_diagnostics',
    {
        sessionId: text('session_id').notNull(),
        filePath: text('file_path').notNull(),
        code: text('code').notNull(),
        message: text('message').notNull(),
        lineNumber: integer('line_number'),
    },
    (table) => [primaryKey({ columns: [table.sessionId, table.filePath, table.code, table.message] })],
);
