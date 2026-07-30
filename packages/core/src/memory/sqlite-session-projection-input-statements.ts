import type { AgentEventEnvelope } from '@mission-control/protocol';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MissionControlDrizzleDb } from '../db/drizzle-client';
import { sessionInputs } from '../db/schema';

export async function projectInputStatements(
    db: MissionControlDrizzleDb,
    envelopes: readonly AgentEventEnvelope[],
): Promise<void> {
    for (const envelope of envelopes) {
        const transcript = envelope.event.transcript;
        if (transcript?.inputId === undefined) continue;
        switch (envelope.event.type) {
            case 'prompt.admitted':
                if (transcript.delivery === undefined) break;
                await db
                    .insert(sessionInputs)
                    .values({
                        inputId: transcript.inputId,
                        sessionId: envelope.sessionId,
                        delivery: transcript.delivery,
                        status: 'admitted',
                        prompt: envelope.event.message ?? '',
                        admittedSeq: envelope.sequence,
                        createdAt: envelope.event.timestamp,
                        admittedAt: envelope.event.timestamp,
                        metadataJson: JSON.stringify({ messageId: transcript.messageId ?? null }),
                    })
                    .onConflictDoUpdate({
                        target: sessionInputs.inputId,
                        set: {
                            sessionId: sql`excluded.session_id`,
                            delivery: sql`excluded.delivery`,
                            status: sql`excluded.status`,
                            prompt: sql`excluded.prompt`,
                            admittedSeq: sql`excluded.admitted_seq`,
                            admittedAt: sql`excluded.admitted_at`,
                            promotedSeq: null,
                            promotedAt: null,
                            cancelledAt: null,
                            metadataJson: sql`excluded.metadata_json`,
                        },
                    });
                break;
            case 'prompt.promoted':
                await db
                    .update(sessionInputs)
                    .set({
                        status: 'promoted',
                        promotedSeq: envelope.sequence,
                        promotedAt: envelope.event.timestamp,
                        cancelledAt: null,
                    })
                    .where(
                        and(
                            eq(sessionInputs.inputId, transcript.inputId),
                            eq(sessionInputs.sessionId, envelope.sessionId),
                            inArray(sessionInputs.status, ['pending', 'admitted']),
                        ),
                    );
                break;
            case 'prompt.cancelled':
                await db
                    .update(sessionInputs)
                    .set({
                        status: 'cancelled',
                        cancelledAt: envelope.event.timestamp,
                        metadataJson: JSON.stringify({
                            requestId: transcript.requestId ?? null,
                            reason: transcript.reason ?? null,
                        }),
                    })
                    .where(
                        and(
                            eq(sessionInputs.inputId, transcript.inputId),
                            eq(sessionInputs.sessionId, envelope.sessionId),
                            inArray(sessionInputs.status, ['pending', 'admitted']),
                        ),
                    );
                break;
            default:
                break;
        }
    }
}
