import { describe, expect, it } from 'vitest';
import { createObservabilityRedactor } from '../providers/observability-redactor';
import { openCanonicalRuntimeDb } from '../runtime/local-runtime-db';
import {
    openLocalSessionEventStore,
    openLocalSessionProjectionStore,
    readLocalSessionReplay,
} from './local-session-store';
import {
    CREATED_AT,
    jsonlFor,
    sessionStartedEvent,
    sessionStoppedEvent,
    tempDataDir,
    writeLegacySource,
} from './local-session-store-test-support';
import { createSessionArchive } from './session-archive-file';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

describe('local session store SQLite-native sessions', () => {
    it('reads, lists, archives, and reopens SQLite-native sessions without a JSONL file', async () => {
        // Given: a new session is written through the local SQLite event store.
        const dataDir = await tempDataDir('native');
        const sessionId = 'session_sqlite_native_core';
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId,
            now: () => CREATED_AT,
            createEventId: (_event, sequence) => `event_native_${sequence}`,
        });
        await store.append(sessionStartedEvent(sessionId));
        await store.append(sessionStoppedEvent(sessionId));
        await store.close();

        // When: core read/list/archive paths reopen the local database.
        const replay = await readLocalSessionReplay({ dataDir, sessionId });
        const projectionStore = await openLocalSessionProjectionStore({ dataDir });
        const listed = await projectionStore.listSessions();
        const session = await projectionStore.getSession(sessionId);
        projectionStore.close();
        const reopenedReplay = await readLocalSessionReplay({ dataDir, sessionId });

        // Then: callers observe the SQLite-native session without relying on a JSONL side file.
        await expect(stat(join(dataDir, 'sessions', `${sessionId}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(dataDir, 'sessions', `${sessionId}.lock`))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(replay.kind).toBe('found');
        expect(reopenedReplay.kind).toBe('found');
        expect(replay.kind === 'found' ? replay.replay.projection.envelopes.map((item) => item.eventId) : []).toEqual([
            'event_native_0',
            'event_native_1',
        ]);
        expect(reopenedReplay).toEqual(replay);
        expect(listed.map((item) => item.sessionId)).toContain(sessionId);
        expect(session).toMatchObject({
            sessionId,
            status: 'stopped',
            eventCount: 2,
            lastEventId: 'event_native_1',
            lastEventType: 'session.stopped',
        });
        const eventsJsonl = jsonlFor(sessionId, replay.kind === 'found' ? replay.replay.projection.envelopes : []);
        const archive = createSessionArchive({
            sessionId,
            cwd: dataDir,
            trustedRoot: dataDir,
            createdAt: CREATED_AT,
            eventsJsonl,
        });
        expect(archive.eventsJsonl).toContain('event_native_1');
    });

    it('prefers SQLite-native rows over a malformed legacy JSONL file with the same session id', async () => {
        // Given: a valid native SQLite session and a stale corrupt JSONL side file share an id.
        const dataDir = await tempDataDir('native-over-legacy');
        const sessionId = 'session_sqlite_native_over_legacy';
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId,
            now: () => CREATED_AT,
            createEventId: (_event, sequence) => `event_native_over_legacy_${sequence}`,
        });
        await store.append(sessionStartedEvent(sessionId));
        await store.close();
        await writeLegacySource(dataDir, sessionId, '{not json}\n');

        // When: core reads the session through the local read API.
        const result = await readLocalSessionReplay({ dataDir, sessionId });

        // Then: the native row is authoritative and stale legacy diagnostics do not mask it.
        expect(result.kind).toBe('found');
        expect(result.kind === 'found' ? result.replay.projection.envelopes.map((item) => item.eventId) : []).toEqual([
            'event_native_over_legacy_0',
        ]);
        expect(result.kind === 'found' ? result.replay.diagnostics : []).toEqual([]);
    });

    it('reapplies a configured redactor when reading canonical SQL replay rows', async () => {
        const dataDir = await tempDataDir('read-redaction');
        const sessionId = 'session_sqlite_read_redaction';
        const credential = ['canonical', 'replay', 'credential'].join('_');
        const store = await openLocalSessionEventStore({ dataDir, sessionId });
        await store.append({
            type: 'task.completed',
            timestamp: CREATED_AT,
            sessionId,
            message: `completed with ${credential}`,
        });
        await store.close();

        const result = await readLocalSessionReplay({
            dataDir,
            sessionId,
            observabilityRedactor: createObservabilityRedactor({ secrets: [credential] }),
        });

        expect(result.kind).toBe('found');
        expect(JSON.stringify(result)).toContain('[REDACTED_CREDENTIAL]');
        expect(JSON.stringify(result)).not.toContain(credential);
    });

    it('uses the configured redactor when startup imports a legacy JSONL session', async () => {
        const dataDir = await tempDataDir('startup-redaction');
        const sessionId = 'session_startup_import_redaction';
        const credential = ['startup', 'legacy', 'credential'].join('_');
        await writeLegacySource(
            dataDir,
            sessionId,
            jsonlFor(sessionId, [
                {
                    eventId: 'event_startup_redaction_0',
                    sequence: 0,
                    createdAt: CREATED_AT,
                    sessionId,
                    durability: 'durable',
                    event: {
                        type: 'task.completed',
                        timestamp: CREATED_AT,
                        sessionId,
                        message: `legacy ${credential}`,
                    },
                },
            ]),
        );
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId,
            observabilityRedactor: createObservabilityRedactor({ secrets: [credential] }),
        });
        await store.close();
        const opened = await openCanonicalRuntimeDb({ dataDir, sessionControlMaintenance: false });

        try {
            const rows = await opened.runtime.client.execute({
                sql: 'SELECT payload_json FROM session_events WHERE session_id = ?',
                args: [sessionId],
            });
            const observable = JSON.stringify(rows.rows);
            expect(observable).toContain('[REDACTED_CREDENTIAL]');
            expect(observable).not.toContain(credential);
        } finally {
            opened.runtime.close();
        }
    });
});
