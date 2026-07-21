import { describe, expect, it } from 'vitest';
import { importSessionEnvelopesToLocalStore } from './session-archive-import';
import { readLocalSessionReplay } from './local-session-store';
import {
    sessionStartedEvent,
    sessionStoppedEvent,
    tempDataDir,
} from './local-session-store-test-support';

describe('local session store SQL replay', () => {
    it('reads sessions that were imported into SQL', async () => {
        // Given: envelopes are imported directly into the local SQL store.
        const dataDir = await tempDataDir('sql-import');
        const sessionId = 'session_sql_import_core';
        const imported = await importSessionEnvelopesToLocalStore({
            dataDir,
            sessionId,
            envelopes: [
                {
                    eventId: 'event_started',
                    sequence: 0,
                    createdAt: '2026-06-05T10:00:00.000Z',
                    sessionId,
                    durability: 'durable',
                    event: sessionStartedEvent(sessionId),
                },
                {
                    eventId: 'event_stopped',
                    sequence: 1,
                    createdAt: '2026-06-05T10:00:01.000Z',
                    sessionId,
                    durability: 'durable',
                    event: sessionStoppedEvent(sessionId),
                },
            ],
        });

        // When: core reads the session through the local read API.
        const result = await readLocalSessionReplay({ dataDir, sessionId });

        // Then: SQL-native events are projected.
        expect(imported).toBe('imported');
        expect(result.kind).toBe('found');
        expect(result.kind === 'found' ? result.replay.projection.events.map((event) => event.type) : []).toEqual([
            'session.started',
            'session.stopped',
        ]);
    });

    it('returns missing when no SQL session rows exist', async () => {
        // Given: the data dir has no session rows for the requested id.
        const dataDir = await tempDataDir('missing');
        const sessionId = 'session_missing_core';

        // When: core reads the session through the local read API.
        const result = await readLocalSessionReplay({ dataDir, sessionId });

        // Then: the read fails closed as missing.
        expect(result).toEqual({ kind: 'missing' });
    });

    it('rejects a second import for a session that already has events', async () => {
        // Given: a session already has durable events in SQL.
        const dataDir = await tempDataDir('collision');
        const sessionId = 'session_collision_core';
        const envelope = {
            eventId: 'event_started',
            sequence: 0,
            createdAt: '2026-06-05T10:00:00.000Z',
            sessionId,
            durability: 'durable' as const,
            event: sessionStartedEvent(sessionId),
        };
        await importSessionEnvelopesToLocalStore({ dataDir, sessionId, envelopes: [envelope] });

        // When: the same session is imported again.
        const second = await importSessionEnvelopesToLocalStore({
            dataDir,
            sessionId,
            envelopes: [{ ...envelope, eventId: 'event_started_again' }],
        });

        // Then: the import reports the existing session.
        expect(second).toBe('session_exists');
    });
});
