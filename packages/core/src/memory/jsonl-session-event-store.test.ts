import { type AgentEventEnvelope, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { JsonlSessionEventStore } from './jsonl-session-event-store.js';
import {
    createTempDataDir,
    readJsonlRecords,
    readJsonRecord,
    sessionStartedEvent,
} from './jsonl-session-event-store-test-support.js';
import { join } from 'node:path';

describe('JsonlSessionEventStore append and locks', () => {
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

    it('prevents concurrent writers from opening the same session log', async () => {
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_lock';
        const firstStore = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            lockOwnerId: 'owner-jsonl-live',
            lockStaleAfterMs: 60_000,
        });

        try {
            const secondOpen = JsonlSessionEventStore.open({ sessionId, dataDir });

            await expect(secondOpen).rejects.toMatchObject({
                code: 'lock_exists',
                sessionId,
            });
        } finally {
            await firstStore.close();
        }
    });

    it('updates lock heartbeat metadata before appending a durable event', async () => {
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_lock_heartbeat';
        let currentTime = '2026-06-12T10:00:00.000Z';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            now: () => currentTime,
            lockOwnerId: 'owner-heartbeat',
            lockPid: 4004,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const lockPath = join(dataDir, 'sessions', `${sessionId}.lock`);

        currentTime = '2026-06-12T10:00:15.000Z';
        await store.append(sessionStartedEvent(sessionId));

        expect(await readJsonRecord(lockPath)).toMatchObject({
            ownerId: 'owner-heartbeat',
            pid: 4004,
            createdAt: '2026-06-12T10:00:00.000Z',
            updatedAt: '2026-06-12T10:00:15.000Z',
            heartbeatAt: '2026-06-12T10:00:15.000Z',
        });
        await store.close();
    });

    it('rejects stale owner appends after its session lock is reclaimed', async () => {
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_stale_owner_append';
        const staleOwner = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            now: () => '2026-06-12T09:00:00.000Z',
            lockOwnerId: 'owner-stale-append',
            lockStaleAfterMs: 30_000,
            createEventId: (_event, sequence) => `stale_${sequence}`,
        });
        const reclaimer = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-reclaimer-append',
            lockStaleAfterMs: 30_000,
            createEventId: (_event, sequence) => `reclaimer_${sequence}`,
        });

        try {
            const staleAppend = staleOwner.append(sessionStartedEvent(sessionId));

            await expect(staleAppend).rejects.toMatchObject({ code: 'lock_exists', sessionId });
            await reclaimer.append(sessionStartedEvent(sessionId));
            await reclaimer.close();
            const records = await readJsonlRecords(join(dataDir, 'sessions', `${sessionId}.jsonl`));
            expect(records.slice(1)).toHaveLength(1);
            expect(records.at(1)).toMatchObject({
                event: {
                    eventId: 'reclaimer_0',
                    sequence: 0,
                },
            });
        } finally {
            await staleOwner.close();
            await reclaimer.close();
        }
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
