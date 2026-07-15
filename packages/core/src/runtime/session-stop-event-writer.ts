import type { Client } from '@libsql/client';
import { type AgentEvent, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { appendParsedSqliteEnvelope } from '../memory/sqlite-session-event-store-append';
import { ensureSqliteSessionRows, readSqliteNextSequence } from '../memory/sqlite-session-event-store-sql';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
} from '../providers/observability-redactor';
import { randomUUID } from 'node:crypto';

export async function appendFencedSessionStopEvent(input: {
    readonly client: Client;
    readonly sessionId: string;
    readonly event: AgentEvent;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<void> {
    await ensureSqliteSessionRows({
        client: input.client,
        sessionId: input.sessionId,
        createdAt: input.event.timestamp,
    });
    const sequence = await readSqliteNextSequence({ client: input.client, sessionId: input.sessionId });
    const envelope = AgentEventEnvelopeSchema.parse(
        redactAgentEventEnvelopeForObservability(
            {
                eventId: randomUUID(),
                sequence,
                createdAt: input.event.timestamp,
                sessionId: input.sessionId,
                durability: 'durable',
                event: input.event,
            },
            input.observabilityRedactor ?? createObservabilityRedactor(),
        ),
    );
    await appendParsedSqliteEnvelope({
        client: input.client,
        sessionId: input.sessionId,
        envelope,
        expectedSequence: sequence,
        now: () => input.event.timestamp,
    });
}
