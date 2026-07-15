import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { openLocalLibsqlDb } from '../db/local-libsql-db';
import { ensurePublicSessionRow, refreshSessionAwaitingFromPendingWaits } from './session-awaiting-sql';
import {
    cleanupSqliteSessionEventStoreTestDirs,
    createSqliteSessionEventStoreTestDbUrl,
} from './sqlite-session-event-store-test-support';
import { projectSessionEventsToSqlite } from './sqlite-session-projection';
import { openSqliteSessionProjectionStoreForTests } from './sqlite-session-projection-test-support';

afterEach(cleanupSqliteSessionEventStoreTestDirs);

describe('session lifecycle transaction integrity', () => {
    it('repairs corrupt lifecycle metadata instead of aborting refresh', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('corrupt-metadata');
        const runtime = await openLocalLibsqlDb({ url });
        await ensurePublicSessionRow({ client: runtime.client, sessionId: 'session_corrupt', now: timestamp });
        await runtime.client.execute({
            sql: 'UPDATE sessions SET metadata_json = ? WHERE session_id = ?',
            args: ['{broken', 'session_corrupt'],
        });

        await expect(
            refreshSessionAwaitingFromPendingWaits({
                client: runtime.client,
                sessionId: 'session_corrupt',
                now: timestamp,
            }),
        ).resolves.toBeUndefined();
        const row = (
            await runtime.client.execute('SELECT status, metadata_json FROM sessions WHERE session_id = ?', [
                'session_corrupt',
            ])
        ).rows[0];
        expect(row).toMatchObject({ status: 'idle', metadata_json: '{}' });
        runtime.close();
    });

    it('rolls back projection replacement when lifecycle refresh fails', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('projection-rollback');
        const observer = await openLocalLibsqlDb({ url });
        await observer.client.execute(`
            CREATE TRIGGER reject_lifecycle_metadata
            BEFORE UPDATE OF metadata_json ON sessions
            BEGIN SELECT RAISE(ABORT, 'reject lifecycle refresh'); END
        `);
        const store = await openSqliteSessionProjectionStoreForTests(url);
        const event = abortCompletedEvent();
        const envelope = AgentEventEnvelopeSchema.parse({
            eventId: 'event_abort',
            sequence: 0,
            createdAt: timestamp,
            sessionId: 'session_rollback',
            durability: 'durable',
            event,
        });

        await expect(
            projectSessionEventsToSqlite({
                store,
                sessionId: 'session_rollback',
                sourcePath: 'transaction-test',
                envelopes: [envelope],
            }),
        ).rejects.toThrow();
        const count = (
            await observer.client.execute(
                "SELECT COUNT(*) AS count FROM sessions WHERE session_id = 'session_rollback'",
            )
        ).rows[0];
        expect(count).toMatchObject({ count: 0 });
        store.close();
        observer.close();
    });

    it('never reanimates a terminal session while active authorities remain', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('terminal-guard');
        const runtime = await openLocalLibsqlDb({ url });
        await ensurePublicSessionRow({ client: runtime.client, sessionId: 'session_terminal', now: timestamp });
        await runtime.client.execute({
            sql: 'UPDATE sessions SET status = ? WHERE session_id = ?',
            args: ['stopped', 'session_terminal'],
        });
        await runtime.client.execute({
            sql: 'INSERT INTO async_jobs (job_id, parent_session_id, status, queued_at) VALUES (?, ?, ?, ?)',
            args: ['job_stale', 'session_terminal', 'running', timestamp],
        });

        await refreshSessionAwaitingFromPendingWaits({
            client: runtime.client,
            sessionId: 'session_terminal',
            now: timestamp,
        });

        const row = (
            await runtime.client.execute('SELECT status FROM sessions WHERE session_id = ?', ['session_terminal'])
        ).rows[0];
        expect(row).toMatchObject({ status: 'stopped' });
        runtime.close();
    });
});

const timestamp = '2026-07-11T14:00:00.000Z';

function abortCompletedEvent() {
    return {
        type: 'session.abort.completed' as const,
        timestamp,
        sessionId: 'session_rollback',
        sessionStop: {
            operationId: 'operation_stop',
            requestId: 'request_stop',
            reason: 'operator_aborted' as const,
            affected: {
                runs: 0,
                approvals: 0,
                sessionAwaits: 0,
                sessionInputs: 0,
                missionRuns: 0,
                asyncJobs: 0,
                toolCalls: 0,
            },
        },
    };
}
