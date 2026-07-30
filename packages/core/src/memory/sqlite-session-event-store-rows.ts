import type { AgentEvent } from '@mission-control/protocol';
import { type AgentEventEnvelope, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { SessionEventLog } from '../session-log';
import { SqliteSessionEventStoreError } from './sqlite-session-event-store-errors';

const nextSequenceRowSchema = z.object({ next_seq: z.number().int().nonnegative() });
const envelopeRowSchema = z.object({ payload_json: z.string() });

export function nextSequenceFrom(result: { readonly rows: readonly unknown[] }, sessionId: string): number {
    const row = result.rows[0];
    if (row === undefined) {
        throw new SqliteSessionEventStoreError({
            code: 'write_failed',
            sessionId,
            message: `SQLite session store ${sessionId} is missing its sequence row`,
        });
    }
    return nextSequenceRowSchema.parse(row).next_seq;
}

export function envelopeFromPayloadRow(row: unknown): AgentEventEnvelope {
    return AgentEventEnvelopeSchema.parse(JSON.parse(envelopeRowSchema.parse(row).payload_json));
}

export function logFromEvents(events: readonly AgentEvent[]): SessionEventLog {
    const log = new SessionEventLog();
    for (const event of events) {
        log.append(event);
    }
    return log;
}
