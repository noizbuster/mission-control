import { afterEach, describe, expect, it } from 'vitest';
import {
    type LocalLibsqlDb,
    openLocalLibsqlDb,
    runLocalLibsqlWrite,
    runWithLocalLibsqlWriteLock,
} from '../db/local-libsql-db.js';
import { deferred } from '../db/local-libsql-registry-test-support.js';
import { SqlAgentJobMirror } from './agent-job-sql-mirror.js';

const runtimes: LocalLibsqlDb[] = [];
const now = '2026-07-12T00:00:00.000Z';

afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close();
});

describe('SqlAgentJobMirror write lane', () => {
    it('keeps schema initialization pending while the target lane is held', async () => {
        // Given
        const runtime = await createRuntime();
        const heldLane = holdWriteLane(runtime);
        await heldLane.started;

        // When
        const creating = SqlAgentJobMirror.create(runtime);

        // Then
        await expectPending(creating);
        heldLane.release();
        await heldLane.done;
        await expect(creating).resolves.toBeInstanceOf(SqlAgentJobMirror);
    });

    it('serializes agent job and relation mutations without lane reentry', async () => {
        // Given
        const runtime = await createRuntime();
        const mirror = await SqlAgentJobMirror.create(runtime);
        const heldLane = holdWriteLane(runtime);
        await heldLane.started;

        // When
        mirror.recordRuntimeAgent({
            id: 'agent-lane',
            displayName: 'lane agent',
            kind: 'sub',
            parentId: 'Main',
            status: 'running',
            sessionId: 'child-lane',
            createdAt: now,
            lastActivity: now,
        });
        mirror.recordJob({
            jobId: 'job-lane',
            sessionId: 'child-lane',
            parentSessionId: 'parent-lane',
            agentId: 'agent-lane',
            blocking: false,
            status: 'running',
            startedAt: now,
        });
        const flushing = mirror.flush();

        // Then
        await expectPending(flushing);
        heldLane.release();
        await Promise.all([heldLane.done, flushing]);
        await expect(mirror.loadRuntimeAgents()).resolves.toHaveLength(1);
        await expect(mirror.loadJobs()).resolves.toHaveLength(1);
        const relations = await runtime.client.execute(
            "SELECT relation_id FROM session_relations WHERE parent_session_id = 'parent-lane'",
        );
        expect(relations.rows).toHaveLength(1);
    });

    it('admits mirror DDL and writes after a rejected queued DDL operation', async () => {
        // Given
        const runtime = await createRuntime();
        const rejectedDdl = runLocalLibsqlWrite(runtime, (client) => client.execute('CREATE TABLE invalid_syntax ('));

        // When
        const creating = SqlAgentJobMirror.create(runtime);

        // Then
        await expect(rejectedDdl).rejects.toBeInstanceOf(Error);
        const mirror = await creating;
        mirror.recordJob({
            jobId: 'job-after-rejection',
            sessionId: 'child-after-rejection',
            status: 'running',
            startedAt: now,
        });
        await mirror.flush();
        await expect(mirror.loadJobs()).resolves.toMatchObject([{ jobId: 'job-after-rejection' }]);
    });
});

async function createRuntime(): Promise<LocalLibsqlDb> {
    const runtime = await openLocalLibsqlDb({ url: ':memory:' });
    runtimes.push(runtime);
    return runtime;
}

function holdWriteLane(target: LocalLibsqlDb): {
    readonly started: Promise<void>;
    readonly release: () => void;
    readonly done: Promise<void>;
} {
    const started = deferred();
    const release = deferred();
    const done = runWithLocalLibsqlWriteLock(target, async () => {
        started.resolve();
        await release.promise;
    });
    return { started: started.promise, release: release.resolve, done };
}

async function expectPending(operation: Promise<unknown>): Promise<void> {
    let settled = false;
    void operation.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
}
