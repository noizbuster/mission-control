import { afterEach, describe, expect, it } from 'vitest';
import { runWithLocalLibsqlWriteLock } from '../db/local-libsql-db.js';
import { resolveLocalLibsqlIdentity } from '../db/local-libsql-identity.js';
import { SqliteSessionEventStore, SqliteSessionEventStoreError } from './sqlite-session-event-store.js';
import {
    cleanupSqliteSessionEventStoreTestDirs,
    createSqliteSessionEventStoreTestDbUrl,
    envelope,
    eventWithoutSession,
    sessionStartedEvent,
    taskCompletedEvent,
} from './sqlite-session-event-store-test-support.js';

afterEach(async () => {
    await cleanupSqliteSessionEventStoreTestDirs();
});

describe('SqliteSessionEventStore concurrency and validation', () => {
    it('serializes queued appends with monotonic per-session sequences', async () => {
        // Given: two appends are queued on one SQLite store.
        const sessionId = 'session_sqlite_queued_append';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('queued');
        const store = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: callers append without awaiting the first write.
            await Promise.all([
                store.append(sessionStartedEvent(sessionId)),
                store.append(taskCompletedEvent(sessionId)),
            ]);

            // Then: the committed envelope sequence is still contiguous and ordered.
            expect((await store.getReplay(sessionId)).envelopes.map((item) => item.sequence)).toEqual([0, 1]);
        } finally {
            await store.close();
        }
    });

    it('serializes concurrent file database writes across store handles', async () => {
        // Given: two SQLite store handles are opened against the same file database.
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('concurrent');
        const firstSessionId = 'session_sqlite_concurrent_first';
        const secondSessionId = 'session_sqlite_concurrent_second';
        const first = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId: firstSessionId,
            createEventId: (_event, sequence) => `first_${sequence}`,
        });
        const second = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId: secondSessionId,
            createEventId: (_event, sequence) => `second_${sequence}`,
        });

        try {
            // When: both handles attempt durable writes at the same time.
            await Promise.all([
                first.append(sessionStartedEvent(firstSessionId)),
                second.append(sessionStartedEvent(secondSessionId)),
            ]);

            // Then: SQLite lock contention does not escape to callers, and both streams commit.
            expect(await first.getEvents(firstSessionId)).toEqual([sessionStartedEvent(firstSessionId)]);
            expect(await second.getEvents(secondSessionId)).toEqual([sessionStartedEvent(secondSessionId)]);
        } finally {
            await first.close();
            await second.close();
        }
    });

    it('waits for an admitted append to drain before close releases the store', async () => {
        // Given: an append is admitted while another writer holds the database lane.
        const sessionId = 'session_sqlite_close_drain';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('close-drain');
        const identity = await resolveLocalLibsqlIdentity({ url: sqliteUrl });
        const store = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        let markWriteStarted = (): void => undefined;
        let releaseWrite = (): void => undefined;
        const writeStarted = new Promise<void>((resolve) => {
            markWriteStarted = resolve;
        });
        const writeRelease = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        const holdingWrite = runWithLocalLibsqlWriteLock(identity.writeKey, async () => {
            markWriteStarted();
            await writeRelease;
        });
        await writeStarted;

        // When: close begins after an append has joined the store queue.
        const appending = store.append(sessionStartedEvent(sessionId));
        let closeSettled = false;
        const closing = store.close().then(() => {
            closeSettled = true;
        });
        await Promise.resolve();

        // Then: close remains pending until the held write and admitted append finish.
        expect(closeSettled).toBe(false);
        releaseWrite();
        await Promise.all([holdingWrite, appending, closing]);
        const reopened = await SqliteSessionEventStore.open({ url: sqliteUrl, sessionId });
        try {
            expect(await reopened.getEvents(sessionId)).toEqual([sessionStartedEvent(sessionId)]);
        } finally {
            await reopened.close();
        }
    });

    it('rejects malformed input, duplicate event ids, and invalid explicit sequences without corrupting the stream', async () => {
        // Given: a SQLite store with one committed event.
        const sessionId = 'session_sqlite_validation';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('validation');
        const store = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const started = sessionStartedEvent(sessionId);
        const next = taskCompletedEvent(sessionId);

        try {
            await store.append(started);
            const duplicateEventId = envelope({
                eventId: 'event_0',
                sequence: 1,
                sessionId,
                event: next,
            });

            // When: invalid writes are attempted.
            await expect(store.append(eventWithoutSession())).rejects.toMatchObject({
                code: 'invalid_event',
                sessionId,
            } satisfies Partial<SqliteSessionEventStoreError>);
            await expect(
                store.appendEnvelope(
                    envelope({
                        eventId: 'event_skipped_sequence',
                        sequence: 7,
                        sessionId,
                        event: next,
                    }),
                ),
            ).rejects.toMatchObject({
                code: 'invalid_sequence',
                sessionId,
            } satisfies Partial<SqliteSessionEventStoreError>);
            await expect(store.appendEnvelope(duplicateEventId)).rejects.toMatchObject({
                code: 'duplicate_event_id',
                sessionId,
            } satisfies Partial<SqliteSessionEventStoreError>);
            await store.append(next);

            // Then: failed writes did not advance the sequence or alter replay state.
            expect((await store.getReplay(sessionId)).envelopes.map((item) => item.eventId)).toEqual([
                'event_0',
                'event_1',
            ]);
        } finally {
            await store.close();
        }
    });
});
