import { type AgentEventEnvelope, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { JsonlSessionEventStore } from './jsonl-session-event-store.js';
import { createTempDataDir, readJsonlRecords, sessionStartedEvent } from './jsonl-session-event-store-test-support.js';
import { join } from 'node:path';

describe('JsonlSessionEventStore append', () => {
    it('creates a versioned header and appends durable event envelopes', async () => {
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_header';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            now: () => '2026-06-04T10:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        await store.append(sessionStartedEvent(sessionId));
        await store.close();

        const records = await readJsonlRecords(join(dataDir, 'sessions', `${sessionId}.jsonl`));
        expect(records).toHaveLength(2);
        expect(records.at(0)).toMatchObject({
            kind: 'mission-control.session-log',
            version: 1,
            sessionId,
            createdAt: '2026-06-04T10:00:00.000Z',
        });
        expect(records.at(1)).toMatchObject({
            kind: 'mission-control.session-event',
            version: 1,
            event: {
                eventId: 'event_0',
                sequence: 0,
                createdAt: '2026-06-04T10:00:00.000Z',
                sessionId,
                durability: 'durable',
                event: {
                    type: 'session.started',
                    sessionId,
                },
            },
        });
    });

    it('parses the envelope exactly once when appending with store sequence', async () => {
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_single_parse';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const envelope: AgentEventEnvelope = {
            eventId: 'event_incoming',
            sequence: 0,
            createdAt: '2026-06-04T10:00:00.000Z',
            sessionId,
            durability: 'durable',
            event: sessionStartedEvent(sessionId),
        };
        const parseSpy = vi.spyOn(AgentEventEnvelopeSchema, 'parse');

        try {
            await store.appendEnvelopeWithStoreSequence(envelope);

            expect(parseSpy).toHaveBeenCalledTimes(1);
            const events = await store.getEvents(sessionId);
            expect(events).toEqual([envelope.event]);
        } finally {
            await store.close();
            parseSpy.mockRestore();
        }
    });
});
