import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlAgentJobMirror } from '../agents/agent-job-sql-mirror.js';
import { localRuntimeDbUrl } from '../runtime/local-runtime-db.js';
import { SqlSessionInputDelivery } from '../runtime/session-input-delivery-sql.js';
import { JsonlSessionEventStore } from './jsonl-session-event-store.js';
import { replayParityEvents, replayParitySummary } from './session-replay-parity-fixtures.js';
import { SqliteSessionEventStore } from './sqlite-session-event-store.js';
import {
    cleanupSqliteSessionEventStoreTestDirs,
    createSqliteSessionEventStoreTestDbUrl,
    createSqliteSessionEventStoreTestDir,
    detailedProjectionEvents,
    sessionStartedEvent,
    taskCompletedEvent,
} from './sqlite-session-event-store-test-support.js';
import { createSqliteSessionIndexStore } from './sqlite-session-projection.js';

afterEach(async () => {
    await cleanupSqliteSessionEventStoreTestDirs();
});

describe('SqliteSessionEventStore', () => {
    it('matches JSONL replay snapshots when appending the parity fixture sequence', async () => {
        // Given: the same session event sequence is written through JSONL and SQLite stores.
        const sessionId = 'session_sqlite_replay_parity';
        const dataDir = await createSqliteSessionEventStoreTestDir('jsonl-data');
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('jsonl-db');
        const jsonl = await JsonlSessionEventStore.open({
            dataDir,
            sessionId,
            now: () => '2026-06-21T10:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const sqlite = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId,
            now: () => '2026-06-21T10:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: each store receives the fixture events.
            for (const event of replayParityEvents(sessionId)) {
                await jsonl.append(event);
                await sqlite.append(event);
            }

            // Then: ordered events and derived snapshots match JSONL behavior.
            expect(await sqlite.getEvents(sessionId)).toEqual(await jsonl.getEvents(sessionId));
            expect(await sqlite.getSnapshot(sessionId)).toEqual(await jsonl.getSnapshot(sessionId));
            expect(replayParitySummary(await sqlite.getReplay(sessionId))).toMatchObject({
                sequences: replayParityEvents(sessionId).map((_event, sequence) => sequence),
                eventIds: replayParityEvents(sessionId).map((_event, sequence) => `event_${sequence}`),
                snapshot: {
                    status: 'stopped',
                    completedTaskCount: 1,
                    lastMessage: 'stopped parity session',
                },
            });
        } finally {
            await jsonl.close();
            await sqlite.close();
        }
    });

    it('reopens a file database with ordered durable events and snapshot state intact', async () => {
        // Given: a SQLite store has appended two durable events to a file database.
        const sessionId = 'session_sqlite_reopen';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('reopen');
        const first = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const started = sessionStartedEvent(sessionId);
        const completed = taskCompletedEvent(sessionId);
        await first.append(started);
        await first.append(completed);
        await first.close();

        // When: a fresh store instance reopens the same database.
        const reopened = await SqliteSessionEventStore.open({ url: sqliteUrl, sessionId });
        const events = await reopened.getEvents(sessionId);
        const snapshot = await reopened.getSnapshot(sessionId);
        await reopened.close();

        // Then: durable ordering and replay projection survived the reopen.
        expect(events).toEqual([started, completed]);
        expect(snapshot).toMatchObject({
            sessionId,
            completedTaskCount: 1,
            lastMessage: 'completed from sqlite',
        });
    });

    it('projects detailed session rows from production append writes', async () => {
        // Given: the production SQLite event store receives a coding-agent event sequence.
        const sessionId = 'session_sqlite_append_projection';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('projection');
        const store = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: callers append through the production store surface.
            for (const event of detailedProjectionEvents(sessionId)) {
                await store.append(event);
            }
        } finally {
            await store.close();
        }

        // Then: the append-only ledger and direct detail projections are queryable without helper seeding.
        const client = createClient({ url: sqliteUrl });
        const events = await client.execute('SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?', [
            sessionId,
        ]);
        const messages = await client.execute(
            'SELECT message_id, role FROM session_messages WHERE session_id = ? ORDER BY seq',
            [sessionId],
        );
        const tools = await client.execute(
            'SELECT tool_call_id, name, status FROM tool_calls WHERE session_id = ? ORDER BY tool_call_id',
            [sessionId],
        );
        const approvals = await client.execute(
            'SELECT approval_id, status FROM approvals WHERE session_id = ? ORDER BY approval_id',
            [sessionId],
        );
        const failures = await client.execute(
            'SELECT event_id, request_id FROM provider_failures WHERE session_id = ? ORDER BY event_id',
            [sessionId],
        );
        client.close();

        expect(events.rows).toEqual([{ count: 10 }]);
        expect(messages.rows).toEqual([{ message_id: 'message_task_prompt_1', role: 'assistant' }]);
        expect(tools.rows).toEqual([{ tool_call_id: 'patch_call', name: 'file.patch', status: 'failed' }]);
        expect(approvals.rows).toEqual([{ approval_id: 'approval_patch', status: 'approved' }]);
        expect(failures.rows).toEqual([{ event_id: 'event_8', request_id: 'provider_request_task_prompt_1' }]);
    });

    it('preserves runtime-owned user_input waits when appending a normal event', async () => {
        // Given: input delivery owns a blocking operator wait before the session event store appends.
        const sessionId = 'session_append_user_input_wait';
        const root = await createSqliteSessionEventStoreTestDir('runtime-user-input');
        const sqliteUrl = localRuntimeDbUrl(root);
        const delivery = await SqlSessionInputDelivery.open(root);
        await delivery.admitInput(sessionId, { inputId: 'operator_prompt', prompt: 'Approve?' }, 'queue', {
            blocking: true,
        });
        delivery.close();
        const store = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: a normal append rebuilds the projection for the same session.
            await store.append(sessionStartedEvent(sessionId));
        } finally {
            await store.close();
        }

        const publicStore = await createSqliteSessionIndexStore({ url: sqliteUrl });
        const client = createClient({ url: sqliteUrl });
        const waits = await client.execute(
            'SELECT wait_id, reason, source_kind, source_id, status FROM session_awaits WHERE session_id = ? ORDER BY wait_id',
            [sessionId],
        );
        const publicSession = await publicStore.getSession(sessionId);
        client.close();
        publicStore.close();

        // Then: the runtime wait remains authoritative until input promotion resolves it.
        expect(waits.rows).toEqual([
            {
                wait_id: 'input_wait_operator_prompt',
                reason: 'user_input',
                source_kind: 'operator',
                source_id: 'operator_prompt',
                status: 'pending',
            },
        ]);
        expect(publicSession).toMatchObject({
            sessionId,
            status: 'awaiting',
            awaiting: {
                reason: 'user_input',
                source: { inputId: 'operator_prompt' },
            },
        });
    });

    it('preserves runtime-owned foreground subagent waits when appending a normal event', async () => {
        // Given: the agent-job mirror owns a foreground child wait before a later append.
        const sessionId = 'session_append_subagent_wait';
        const childSessionId = 'child_append_subagent_wait';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('runtime-subagent');
        const client = createClient({ url: sqliteUrl });
        const mirror = await SqlAgentJobMirror.create(client);
        await mirror.startSubagentWait({
            parentSessionId: sessionId,
            childSessionId,
            mode: 'sync',
        });
        await mirror.flush();
        const store = await SqliteSessionEventStore.open({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: a normal append rebuilds the projection for the parent session.
            await store.append(sessionStartedEvent(sessionId));
        } finally {
            await store.close();
        }

        const publicStore = await createSqliteSessionIndexStore({ url: sqliteUrl });
        const waits = await client.execute(
            'SELECT wait_id, reason, source_kind, source_id, status FROM session_awaits WHERE session_id = ? ORDER BY wait_id',
            [sessionId],
        );
        const publicSession = await publicStore.getSession(sessionId);
        client.close();
        publicStore.close();

        // Then: the foreground child wait still drives public awaiting/subagent status.
        expect(waits.rows).toEqual([
            {
                wait_id: childSessionId,
                reason: 'subagent',
                source_kind: 'child_session',
                source_id: childSessionId,
                status: 'pending',
            },
        ]);
        expect(publicSession).toMatchObject({
            sessionId,
            status: 'awaiting',
            awaiting: {
                reason: 'subagent',
                source: {
                    jobId: childSessionId,
                    childSessionId,
                },
            },
        });
    });
});
