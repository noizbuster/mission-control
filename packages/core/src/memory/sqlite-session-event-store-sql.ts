import type { Client } from '@libsql/client';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { sessionAwaits, sessionEventSequences, sessionEvents, sessions } from '../db/schema';
import { nextSequenceFrom } from './sqlite-session-event-store-rows';

type SessionSqlInput = {
    readonly client: Client;
    readonly sessionId: string;
};

export async function ensureSqliteSessionRows(input: SessionSqlInput & { readonly createdAt: string }): Promise<void> {
    const db = drizzleFromClient(input.client);
    await db
        .insert(sessions)
        .values({
            sessionId: input.sessionId,
            status: 'running',
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
            lastActivityAt: input.createdAt,
        })
        .onConflictDoNothing({ target: sessions.sessionId });
    await db
        .insert(sessionEventSequences)
        .values({
            sessionId: input.sessionId,
            nextSeq: 0,
            updatedAt: input.createdAt,
        })
        .onConflictDoNothing({ target: sessionEventSequences.sessionId });
}

export async function readSqliteNextSequence(input: SessionSqlInput): Promise<number> {
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({ next_seq: sessionEventSequences.nextSeq })
        .from(sessionEventSequences)
        .where(eq(sessionEventSequences.sessionId, input.sessionId));
    return nextSequenceFrom({ rows }, input.sessionId);
}

export async function hasSqliteEventId(input: SessionSqlInput & { readonly eventId: string }): Promise<boolean> {
    const db = drizzleFromClient(input.client);
    const existing = await db
        .select({ eventId: sessionEvents.eventId })
        .from(sessionEvents)
        .where(eq(sessionEvents.eventId, input.eventId))
        .limit(1);
    return existing.length > 0;
}

export async function insertSqliteSessionEnvelope(
    input: SessionSqlInput & { readonly envelope: AgentEventEnvelope },
): Promise<void> {
    const db = drizzleFromClient(input.client);
    await db.insert(sessionEvents).values({
        sessionId: input.sessionId,
        seq: input.envelope.sequence,
        eventId: input.envelope.eventId,
        type: input.envelope.event.type,
        timestamp: input.envelope.event.timestamp,
        runId: input.envelope.event.run?.runId ?? null,
        turnId: null,
        causationId: input.envelope.causationId ?? null,
        correlationId: input.envelope.correlationId ?? null,
        payloadJson: JSON.stringify(input.envelope),
    });
}

export async function touchSqliteSessionActivity(
    input: SessionSqlInput & {
        readonly activityAt: string;
        readonly status?: 'running';
    },
): Promise<void> {
    const db = drizzleFromClient(input.client);
    const status = input.status ?? null;
    await db
        .update(sessions)
        .set({
            updatedAt: input.activityAt,
            lastActivityAt: input.activityAt,
            status: sql`CASE
                WHEN ${sessions.status} IN ('stopped', 'failed') THEN ${sessions.status}
                WHEN ${status} IS NOT NULL THEN ${status}
                ELSE ${sessions.status}
            END`,
        })
        .where(eq(sessions.sessionId, input.sessionId));
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
    const db = drizzleFromClient(input.client);
    await db
        .update(sessionEventSequences)
        .set({
            nextSeq: input.sequence + 1,
            updatedAt: input.sequenceUpdatedAt,
        })
        .where(eq(sessionEventSequences.sessionId, input.sessionId));

    const nextStatus = sessionStatusAfterEvent(input.event);
    const clearsWait = clearsPendingApprovalWait(input.event);
    const eventType = input.event.type;
    const waitId = approvalWaitId(input.event);

    await db
        .update(sessions)
        .set({
            status: sql`CASE
                WHEN ${nextStatus} IS NOT NULL THEN ${nextStatus}
                ELSE ${sessions.status}
            END`,
            awaitingReason: sql`CASE
                WHEN ${eventType} = 'run.blocked' THEN 'approval'
                WHEN ${clearsWait} OR ${eventType} = 'session.stopped' THEN NULL
                ELSE ${sessions.awaitingReason}
            END`,
            primaryWaitId: sql`CASE
                WHEN ${eventType} = 'run.blocked' THEN ${waitId}
                WHEN ${clearsWait} OR ${eventType} = 'session.stopped' THEN NULL
                ELSE ${sessions.primaryWaitId}
            END`,
            stoppedAt: sql`CASE WHEN ${eventType} = 'session.stopped' THEN ${input.activityAt} ELSE ${sessions.stoppedAt} END`,
            lastEventSeq: input.sequence,
            updatedAt: input.sequenceUpdatedAt,
            lastActivityAt: input.activityAt,
            metadataJson: JSON.stringify({
                eventCount: input.sequence + 1,
                lastEventId: input.eventId,
                lastEventType: input.event.type,
            }),
        })
        .where(eq(sessions.sessionId, input.sessionId));

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
        case 'run.idle':
        case 'task.failed':
        case 'task.completed':
            return 'idle';
        case 'run.started':
        case 'task.started':
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
        case 'run.idle':
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
    const db = drizzleFromClient(input.client);
    const metadataJson = JSON.stringify({ reason: input.event.run?.reason ?? null });
    await db
        .insert(sessionAwaits)
        .values({
            waitId,
            sessionId: input.sessionId,
            reason: 'approval',
            sourceKind: input.event.run?.toolCallId === undefined ? 'run' : 'tool_call',
            sourceId: waitId,
            runId: input.event.run?.runId ?? null,
            toolCallId: input.event.run?.toolCallId ?? null,
            approvalId: null,
            status: 'pending',
            createdAt: input.createdAt,
            metadataJson,
        })
        .onConflictDoUpdate({
            target: sessionAwaits.waitId,
            set: {
                status: 'pending',
                resolvedAt: null,
                cancelledAt: null,
                metadataJson,
            },
        });
}

async function resolveApprovalWaits(input: SessionSqlInput & { readonly resolvedAt: string }) {
    const db = drizzleFromClient(input.client);
    await db
        .update(sessionAwaits)
        .set({
            status: 'resolved',
            resolvedAt: input.resolvedAt,
        })
        .where(
            and(
                eq(sessionAwaits.sessionId, input.sessionId),
                eq(sessionAwaits.reason, 'approval'),
                eq(sessionAwaits.status, 'pending'),
            ),
        );
}

async function cancelApprovalWaits(input: SessionSqlInput & { readonly cancelledAt: string }) {
    const db = drizzleFromClient(input.client);
    await db
        .update(sessionAwaits)
        .set({
            status: 'cancelled',
            resolvedAt: null,
            cancelledAt: input.cancelledAt,
        })
        .where(
            and(
                eq(sessionAwaits.sessionId, input.sessionId),
                eq(sessionAwaits.reason, 'approval'),
                eq(sessionAwaits.status, 'pending'),
            ),
        );
}

async function cancelInputWait(input: SessionSqlInput & { readonly inputId: string; readonly cancelledAt: string }) {
    const db = drizzleFromClient(input.client);
    await db
        .update(sessionAwaits)
        .set({
            status: 'cancelled',
            resolvedAt: null,
            cancelledAt: input.cancelledAt,
        })
        .where(
            and(
                eq(sessionAwaits.sessionId, input.sessionId),
                eq(sessionAwaits.sourceKind, 'operator'),
                eq(sessionAwaits.sourceId, input.inputId),
                eq(sessionAwaits.status, 'pending'),
            ),
        );
}
