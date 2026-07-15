import type { Client } from '@libsql/client';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { nextSequenceFrom } from './sqlite-session-event-store-rows';

type SessionSqlInput = {
    readonly client: Client;
    readonly sessionId: string;
};

export async function ensureSqliteSessionRows(input: SessionSqlInput & { readonly createdAt: string }): Promise<void> {
    await input.client.execute({
        sql: `
            INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at)
            VALUES (?, 'running', ?, ?, ?)
            ON CONFLICT(session_id) DO NOTHING
        `,
        args: [input.sessionId, input.createdAt, input.createdAt, input.createdAt],
    });
    await input.client.execute({
        sql: `
            INSERT INTO session_event_sequences (session_id, next_seq, updated_at)
            VALUES (?, 0, ?)
            ON CONFLICT(session_id) DO NOTHING
        `,
        args: [input.sessionId, input.createdAt],
    });
}

export async function readSqliteNextSequence(input: SessionSqlInput): Promise<number> {
    const row = await input.client.execute({
        sql: 'SELECT next_seq FROM session_event_sequences WHERE session_id = ?',
        args: [input.sessionId],
    });
    return nextSequenceFrom(row, input.sessionId);
}

export async function hasSqliteEventId(input: SessionSqlInput & { readonly eventId: string }): Promise<boolean> {
    const existing = await input.client.execute({
        sql: 'SELECT event_id FROM session_events WHERE event_id = ?',
        args: [input.eventId],
    });
    return existing.rows.length > 0;
}

export async function insertSqliteSessionEnvelope(
    input: SessionSqlInput & { readonly envelope: AgentEventEnvelope },
): Promise<void> {
    await input.client.execute({
        sql: `
            INSERT INTO session_events (
                session_id, seq, event_id, type, timestamp, run_id, turn_id,
                causation_id, correlation_id, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
            input.sessionId,
            input.envelope.sequence,
            input.envelope.eventId,
            input.envelope.event.type,
            input.envelope.event.timestamp,
            input.envelope.event.run?.runId ?? null,
            null,
            input.envelope.causationId ?? null,
            input.envelope.correlationId ?? null,
            JSON.stringify(input.envelope),
        ],
    });
}

export async function updateSqliteSessionAfterAppend(
    input: SessionSqlInput & {
        readonly event: AgentEvent;
        readonly sequence: number;
        readonly eventId: string;
        readonly sequenceUpdatedAt: string;
        readonly activityAt: string;
    },
): Promise<void> {
    await input.client.execute({
        sql: 'UPDATE session_event_sequences SET next_seq = ?, updated_at = ? WHERE session_id = ?',
        args: [input.sequence + 1, input.sequenceUpdatedAt, input.sessionId],
    });
    const nextStatus = sessionStatusAfterEvent(input.event);
    const clearsWait = clearsPendingApprovalWait(input.event);
    await input.client.execute({
        sql: `
            UPDATE sessions
            SET status = CASE
                    WHEN ? IS NOT NULL THEN ?
                    ELSE status
                END,
                awaiting_reason = CASE
                    WHEN ? = 'run.blocked' THEN 'approval'
                    WHEN ? OR ? = 'session.stopped' THEN NULL
                    ELSE awaiting_reason
                END,
                primary_wait_id = CASE
                    WHEN ? = 'run.blocked' THEN ?
                    WHEN ? OR ? = 'session.stopped' THEN NULL
                    ELSE primary_wait_id
                END,
                stopped_at = CASE WHEN ? = 'session.stopped' THEN ? ELSE stopped_at END,
                last_event_seq = ?,
                updated_at = ?,
                last_activity_at = ?,
                metadata_json = ?
            WHERE session_id = ?
        `,
        args: [
            nextStatus,
            nextStatus,
            input.event.type,
            clearsWait,
            input.event.type,
            input.event.type,
            approvalWaitId(input.event),
            clearsWait,
            input.event.type,
            input.event.type,
            input.activityAt,
            input.sequence,
            input.sequenceUpdatedAt,
            input.activityAt,
            JSON.stringify({
                eventCount: input.sequence + 1,
                lastEventId: input.eventId,
                lastEventType: input.event.type,
            }),
            input.sessionId,
        ],
    });
    if (isApprovalBlockedRun(input.event)) {
        await insertApprovalWait({
            client: input.client,
            sessionId: input.sessionId,
            event: input.event,
            createdAt: input.activityAt,
        });
    }
    if (isCancelledApproval(input.event)) {
        await cancelApprovalWaits({ client: input.client, sessionId: input.sessionId, cancelledAt: input.activityAt });
    } else if (clearsPendingApprovalWait(input.event) || input.event.type === 'session.stopped') {
        await resolveApprovalWaits({ client: input.client, sessionId: input.sessionId, resolvedAt: input.activityAt });
    }
    if (input.event.type === 'prompt.cancelled' && input.event.transcript?.inputId !== undefined) {
        await cancelInputWait({
            client: input.client,
            sessionId: input.sessionId,
            inputId: input.event.transcript.inputId,
            cancelledAt: input.activityAt,
        });
    }
}

function sessionStatusAfterEvent(event: AgentEvent): 'stopped' | 'awaiting' | 'running' | 'idle' | null {
    switch (event.type) {
        case 'session.stopped':
            return 'stopped';
        case 'run.blocked':
            return 'awaiting';
        case 'run.completed':
        case 'run.failed':
        case 'run.interrupted':
            return 'idle';
        case 'run.started':
        case 'approval.updated':
        case 'approval.resumed':
        case 'tool.completed':
            return 'running';
        default:
            return null;
    }
}

function isApprovalBlockedRun(event: AgentEvent): boolean {
    return event.type === 'run.blocked' && event.run?.state === 'blocked_on_approval';
}

function clearsPendingApprovalWait(event: AgentEvent): boolean {
    switch (event.type) {
        case 'approval.updated':
        case 'approval.resumed':
        case 'tool.completed':
        case 'run.completed':
        case 'run.failed':
        case 'run.interrupted':
            return true;
        default:
            return false;
    }
}

function isCancelledApproval(event: AgentEvent): boolean {
    return event.type === 'approval.updated' && event.approvalRecord?.state === 'cancelled';
}

function approvalWaitId(event: AgentEvent): string | null {
    if (!isApprovalBlockedRun(event)) {
        return null;
    }
    return event.run?.toolCallId ?? event.run?.runId ?? event.taskId ?? event.type;
}

async function insertApprovalWait(input: SessionSqlInput & { readonly event: AgentEvent; readonly createdAt: string }) {
    const waitId = approvalWaitId(input.event);
    if (waitId === null) {
        return;
    }
    await input.client.execute({
        sql: `
            INSERT INTO session_awaits (
                wait_id, session_id, reason, source_kind, source_id, run_id, tool_call_id,
                approval_id, status, created_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(wait_id) DO UPDATE SET
                status = excluded.status,
                resolved_at = NULL,
                cancelled_at = NULL,
                metadata_json = excluded.metadata_json
        `,
        args: [
            waitId,
            input.sessionId,
            'approval',
            input.event.run?.toolCallId === undefined ? 'run' : 'tool_call',
            waitId,
            input.event.run?.runId ?? null,
            input.event.run?.toolCallId ?? null,
            null,
            'pending',
            input.createdAt,
            JSON.stringify({ reason: input.event.run?.reason ?? null }),
        ],
    });
}

async function resolveApprovalWaits(input: SessionSqlInput & { readonly resolvedAt: string }) {
    await input.client.execute({
        sql: 'UPDATE session_awaits SET status = ?, resolved_at = ? WHERE session_id = ? AND reason = ? AND status = ?',
        args: ['resolved', input.resolvedAt, input.sessionId, 'approval', 'pending'],
    });
}

async function cancelApprovalWaits(input: SessionSqlInput & { readonly cancelledAt: string }) {
    await input.client.execute({
        sql: 'UPDATE session_awaits SET status = ?, resolved_at = NULL, cancelled_at = ? WHERE session_id = ? AND reason = ? AND status = ?',
        args: ['cancelled', input.cancelledAt, input.sessionId, 'approval', 'pending'],
    });
}

async function cancelInputWait(input: SessionSqlInput & { readonly inputId: string; readonly cancelledAt: string }) {
    await input.client.execute({
        sql: `
            UPDATE session_awaits
            SET status = ?, resolved_at = NULL, cancelled_at = ?
            WHERE session_id = ? AND source_kind = ? AND source_id = ? AND status = ?
        `,
        args: ['cancelled', input.cancelledAt, input.sessionId, 'operator', input.inputId, 'pending'],
    });
}
