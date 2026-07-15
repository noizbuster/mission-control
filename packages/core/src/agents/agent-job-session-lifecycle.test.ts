import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openLocalLibsqlDb } from '../db/local-libsql-db';
import { SqliteSessionEventStore } from '../memory/sqlite-session-event-store';
import {
    cleanupSqliteSessionEventStoreTestDirs,
    createSqliteSessionEventStoreTestDbUrl,
    openSqliteSessionEventStoreForTests,
} from '../memory/sqlite-session-event-store-test-support';
import { SqlAgentJobMirror } from './agent-job-sql-mirror';

const sessionRowSchema = z.object({ status: z.string(), metadata_json: z.string().nullable() });
const countRowSchema = z.object({ count: z.number() });

afterEach(cleanupSqliteSessionEventStoreTestDirs);

describe('agent job session lifecycle', () => {
    it('settles the final job to idle(aborted) without appending a session event', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('job-settlement');
        const store = await openStore(url, 'session_job_settlement');
        await store.append({
            type: 'session.started',
            timestamp,
            sessionId: 'session_job_settlement',
        });
        const runtime = await openLocalLibsqlDb({ url });
        const mirror = await SqlAgentJobMirror.create(runtime);
        mirror.recordJob(jobHandle('running'));
        await mirror.flush();
        await store.append(abortCompletedEvent('session_job_settlement'));
        const before = await sessionRow(runtime, 'session_job_settlement');
        const eventCountBefore = await eventCount(runtime, 'session_job_settlement');

        mirror.recordJob(jobHandle('cancelled'));
        await mirror.flush();

        const after = await sessionRow(runtime, 'session_job_settlement');
        expect(before).toMatchObject({ status: 'running' });
        expect(after).toMatchObject({ status: 'idle' });
        expect(JSON.parse(String(after.metadata_json))).toMatchObject({ lifecycleReason: 'aborted' });
        expect(await eventCount(runtime, 'session_job_settlement')).toBe(eventCountBefore);
        runtime.close();
        await store.close();
    });

    it('rolls back a job write when lifecycle refresh fails', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('job-rollback');
        const store = await openStore(url, 'session_job_rollback');
        await store.append({ type: 'session.started', timestamp, sessionId: 'session_job_rollback' });
        await store.close();
        const runtime = await openLocalLibsqlDb({ url });
        const mirror = await SqlAgentJobMirror.create(runtime);
        await runtime.client.execute(`
            CREATE TRIGGER reject_job_lifecycle
            BEFORE UPDATE OF status ON sessions
            BEGIN SELECT RAISE(ABORT, 'reject job lifecycle refresh'); END
        `);

        mirror.recordJob({ ...jobHandle('running'), parentSessionId: 'session_job_rollback' });
        await expect(mirror.flush()).rejects.toThrow();
        const count = (
            await runtime.client.execute("SELECT COUNT(*) AS count FROM async_jobs WHERE job_id = 'job_active'")
        ).rows[0];
        expect(count).toMatchObject({ count: 0 });
        runtime.close();
    });
});

const timestamp = '2026-07-11T14:00:00.000Z';

function jobHandle(status: 'running' | 'cancelled') {
    return {
        jobId: 'job_active',
        sessionId: 'session_job_child',
        parentSessionId: 'session_job_settlement',
        blocking: false,
        status,
        startedAt: timestamp,
        ...(status === 'cancelled'
            ? { completedAt: '2026-07-11T14:00:03.000Z', cancellationReason: 'operator_aborted' }
            : {}),
    };
}

function abortCompletedEvent(sessionId: string) {
    return {
        type: 'session.abort.completed' as const,
        timestamp: '2026-07-11T14:00:02.000Z',
        sessionId,
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
                asyncJobs: 1,
                toolCalls: 0,
            },
        },
    };
}

async function openStore(url: string, sessionId: string): Promise<SqliteSessionEventStore> {
    return openSqliteSessionEventStoreForTests({
        url,
        sessionId,
        now: () => timestamp,
        createEventId: (_event, sequence) => `event_${sequence}`,
    });
}

async function sessionRow(runtime: Awaited<ReturnType<typeof openLocalLibsqlDb>>, sessionId: string) {
    return sessionRowSchema.parse(
        (await runtime.client.execute('SELECT status, metadata_json FROM sessions WHERE session_id = ?', [sessionId]))
            .rows[0],
    );
}

async function eventCount(runtime: Awaited<ReturnType<typeof openLocalLibsqlDb>>, sessionId: string): Promise<unknown> {
    return countRowSchema.parse(
        (await runtime.client.execute('SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?', [sessionId]))
            .rows[0],
    ).count;
}
