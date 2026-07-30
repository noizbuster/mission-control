import type { AgentEventEnvelope } from '@mission-control/protocol';
import { sql } from 'drizzle-orm';
import type { MissionControlDrizzleDb } from '../db/drizzle-client';
import { sessionAwaits } from '../db/schema';

export async function projectCancelledWaitStatements(
    db: MissionControlDrizzleDb,
    envelopes: readonly AgentEventEnvelope[],
): Promise<void> {
    const inputCreatedAt = new Map<string, string>();
    for (const envelope of envelopes) {
        const event = envelope.event;
        const inputId = event.transcript?.inputId;
        if (event.type === 'prompt.admitted' && inputId !== undefined) {
            inputCreatedAt.set(inputId, event.timestamp);
        }
        if (event.type === 'prompt.cancelled' && inputId !== undefined) {
            await insertCancelledWait(db, {
                waitId: `input_wait_${inputId}`,
                sessionId: envelope.sessionId,
                reason: 'user_input',
                sourceKind: 'operator',
                sourceId: inputId,
                createdAt: inputCreatedAt.get(inputId) ?? event.timestamp,
                cancelledAt: event.timestamp,
                metadata: {
                    requestId: event.transcript?.requestId ?? null,
                    reason: event.transcript?.reason ?? null,
                },
            });
        }
        const approval = event.approvalRecord;
        if (event.type === 'approval.updated' && approval?.state === 'cancelled') {
            await insertCancelledWait(db, {
                waitId: approval.approvalId,
                sessionId: envelope.sessionId,
                reason: 'approval',
                sourceKind: 'approval',
                sourceId: approval.approvalId,
                approvalId: approval.approvalId,
                createdAt: approval.requestedAt,
                cancelledAt: event.timestamp,
                metadata: { requestId: approval.requestId, reason: approval.reason ?? null },
            });
        }
    }
}

async function insertCancelledWait(
    db: MissionControlDrizzleDb,
    input: {
        readonly waitId: string;
        readonly sessionId: string;
        readonly reason: 'approval' | 'user_input';
        readonly sourceKind: 'approval' | 'operator';
        readonly sourceId: string;
        readonly approvalId?: string;
        readonly createdAt: string;
        readonly cancelledAt: string;
        readonly metadata: Readonly<Record<string, string | null>>;
    },
): Promise<void> {
    await db
        .insert(sessionAwaits)
        .values({
            waitId: input.waitId,
            sessionId: input.sessionId,
            reason: input.reason,
            sourceKind: input.sourceKind,
            sourceId: input.sourceId,
            approvalId: input.approvalId ?? null,
            status: 'cancelled',
            createdAt: input.createdAt,
            cancelledAt: input.cancelledAt,
            metadataJson: JSON.stringify(input.metadata),
        })
        .onConflictDoUpdate({
            target: sessionAwaits.waitId,
            set: {
                status: sql`excluded.status`,
                resolvedAt: null,
                cancelledAt: sql`excluded.cancelled_at`,
                metadataJson: sql`excluded.metadata_json`,
            },
        });
}
