// allow: SIZE_OK -- HEAD 248 -> current 268 pure LOC; sql task runtime services persistence and forwarding coverage.
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { missionControlDataDirEnvKey } from '../memory/data-dir';
import { openLocalSessionEventStore } from '../memory/local-session-store-open';
import { localRuntimeDbUrl } from '../runtime/local-runtime-db';
import { createSqlTaskRuntimeServices } from './sql-task-runtime-services';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

async function makeWorkspaceRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-sql-services-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createSqlTaskRuntimeServices', () => {
    it('defaults runtime_agents async_jobs and session_relations to MCTRL_DATA_DIR mission-control.db', async () => {
        const dataDir = await makeWorkspaceRoot();
        const previousDataDir = process.env[missionControlDataDirEnvKey];
        process.env[missionControlDataDirEnvKey] = dataDir;
        const sessionStore = await openLocalSessionEventStore({ sessionId: 'public-default-data-dir-session' });
        const services = await createSqlTaskRuntimeServices(undefined, { maxConcurrency: 1 });
        try {
            await sessionStore.append({
                type: 'task.started',
                timestamp: '2026-07-06T00:00:00.000Z',
                sessionId: 'public-default-data-dir-session',
                taskId: 'task_public_default_data_dir',
                message: 'public session event in shared data-dir mission-control.db',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            });
            services.runtimeRegistry.adopt({
                id: 'child-default-data-dir',
                displayName: 'deep',
                kind: 'sub',
                parentId: 'Main',
                status: 'running',
                sessionId: 'child-default-data-dir',
            });
            const handle = services.jobManager.startJob({
                sessionId: 'child-default-data-dir',
                parentSessionId: 'parent-default-data-dir',
                agentId: 'deep',
                blocking: false,
                execute: async () => ({ status: 'completed', output: 'default data dir output' }),
            });
            await services.jobManager.awaitJob(handle.jobId);
            await services.mirror.startSubagentWait({
                parentSessionId: 'parent-default-data-dir',
                childSessionId: 'child-default-data-dir',
                agentId: 'deep',
                mode: 'sync',
            });
            await services.flush();
        } finally {
            try {
                await services.close();
            } finally {
                await sessionStore.close();
            }
            if (previousDataDir === undefined) {
                delete process.env[missionControlDataDirEnvKey];
            } else {
                process.env[missionControlDataDirEnvKey] = previousDataDir;
            }
        }

        const client = createClient({ url: localRuntimeDbUrl(dataDir) });
        try {
            const runtimeAgents = await client.execute(
                "SELECT agent_id, session_id, status FROM runtime_agents WHERE agent_id = 'child-default-data-dir'",
            );
            const asyncJobs = await client.execute(
                "SELECT child_session_id, parent_session_id, status FROM async_jobs WHERE child_session_id = 'child-default-data-dir' ORDER BY queued_at",
            );
            const relations = await client.execute(
                "SELECT parent_session_id, child_session_id, kind FROM session_relations WHERE child_session_id = 'child-default-data-dir'",
            );
            const publicSessions = await client.execute(
                "SELECT session_id FROM sessions WHERE session_id IN ('parent-default-data-dir', 'child-default-data-dir') ORDER BY session_id",
            );
            const publicSessionEvents = await client.execute(
                "SELECT session_id, type FROM session_events WHERE session_id = 'public-default-data-dir-session'",
            );

            expect(runtimeAgents.rows).toEqual([
                {
                    agent_id: 'child-default-data-dir',
                    session_id: 'child-default-data-dir',
                    status: 'running',
                },
            ]);
            expect(asyncJobs.rows).toEqual(
                expect.arrayContaining([
                    {
                        child_session_id: 'child-default-data-dir',
                        parent_session_id: 'parent-default-data-dir',
                        status: 'running',
                    },
                    {
                        child_session_id: 'child-default-data-dir',
                        parent_session_id: 'parent-default-data-dir',
                        status: 'completed',
                    },
                ]),
            );
            expect(relations.rows).toEqual([
                {
                    parent_session_id: 'parent-default-data-dir',
                    child_session_id: 'child-default-data-dir',
                    kind: 'subagent',
                },
            ]);
            expect(publicSessions.rows).toEqual([
                { session_id: 'child-default-data-dir' },
                { session_id: 'parent-default-data-dir' },
            ]);
            expect(publicSessionEvents.rows).toEqual([
                { session_id: 'public-default-data-dir-session', type: 'task.started' },
            ]);
        } finally {
            client.close();
        }
    });

    it('reopens durable runtime_agents async_jobs and session_relations rows from production managers', async () => {
        const mcRoot = await makeWorkspaceRoot();
        const dataDir = await makeWorkspaceRoot();
        const services = await createSqlTaskRuntimeServices(dataDir, { maxConcurrency: 1 });
        services.runtimeRegistry.adopt({
            id: 'child-session',
            displayName: 'deep',
            kind: 'sub',
            parentId: 'Main',
            status: 'running',
            sessionId: 'child-session',
        });
        const handle = services.jobManager.startJob({
            sessionId: 'child-session',
            parentSessionId: 'parent-session',
            agentId: 'deep',
            blocking: false,
            execute: async () => ({ status: 'completed', output: 'yielded output' }),
        });
        await services.jobManager.awaitJob(handle.jobId);
        await services.mirror.startSubagentWait({
            parentSessionId: 'parent-session',
            childSessionId: 'child-session',
            agentId: 'deep',
            mode: 'sync',
        });
        await services.flush();
        await services.close();

        const client = createClient({ url: localRuntimeDbUrl(dataDir) });
        try {
            const runtimeAgents = await client.execute(
                "SELECT agent_id, session_id, status FROM runtime_agents WHERE agent_id = 'child-session'",
            );
            const asyncJobs = await client.execute(
                "SELECT child_session_id, parent_session_id, status FROM async_jobs WHERE child_session_id = 'child-session' ORDER BY queued_at",
            );
            const relations = await client.execute(
                "SELECT parent_session_id, child_session_id, kind FROM session_relations WHERE child_session_id = 'child-session'",
            );

            expect(runtimeAgents.rows).toEqual([
                { agent_id: 'child-session', session_id: 'child-session', status: 'running' },
            ]);
            expect(asyncJobs.rows).toEqual(
                expect.arrayContaining([
                    {
                        child_session_id: 'child-session',
                        parent_session_id: 'parent-session',
                        status: 'completed',
                    },
                ]),
            );
            expect(relations.rows).toEqual([
                {
                    parent_session_id: 'parent-session',
                    child_session_id: 'child-session',
                    kind: 'subagent',
                },
            ]);
        } finally {
            client.close();
        }

        expect(existsSync(join(dataDir, 'mission-control.db'))).toBe(true);
        expect(existsSync(join(mcRoot, 'mission-control.db'))).toBe(false);
        const reopened = await createSqlTaskRuntimeServices(dataDir);
        try {
            expect(reopened.runtimeRegistry.lookup('child-session')?.sessionId).toBe('child-session');
            const jobs = await reopened.mirror.loadJobs();
            expect(jobs.some((job) => job.sessionId === 'child-session')).toBe(true);
        } finally {
            await reopened.close();
        }
    });

    it('forwards onTerminalJob to the job manager terminal listener', async () => {
        const dataDir = await makeWorkspaceRoot();
        const statuses: string[] = [];
        const services = await createSqlTaskRuntimeServices(dataDir, {
            maxConcurrency: 1,
            onTerminalJob: (handle) => {
                statuses.push(handle.status);
            },
        });
        try {
            const handle = services.jobManager.startJob({
                sessionId: 'session_on_terminal_forward',
                execute: async () => ({ status: 'completed' as const, output: 'ok' }),
            });
            await services.jobManager.awaitJob(handle.jobId);
            expect(statuses).toEqual(['completed']);
        } finally {
            await services.close();
        }
    });

    it('drains active jobs and mirror writes before service close releases the database', async () => {
        // Given: one active job has started but its terminal mirror write cannot exist yet.
        const dataDir = await makeWorkspaceRoot();
        const services = await createSqlTaskRuntimeServices(dataDir, { maxConcurrency: 1 });
        let markJobStarted = (): void => undefined;
        let releaseJob = (): void => undefined;
        const jobStarted = new Promise<void>((resolve) => {
            markJobStarted = resolve;
        });
        const jobRelease = new Promise<void>((resolve) => {
            releaseJob = resolve;
        });
        services.jobManager.startJob({
            sessionId: 'child-close-drain',
            parentSessionId: 'parent-close-drain',
            agentId: 'deep',
            blocking: false,
            execute: async () => {
                markJobStarted();
                await jobRelease;
                return { status: 'completed', output: 'close drained output' };
            },
        });
        await jobStarted;

        // When: service close begins before the active job completes.
        let closeSettled = false;
        const closing = services.close().then(() => {
            closeSettled = true;
        });
        await Promise.resolve();

        // Then: close waits, then persists the terminal mirror row before releasing its lease.
        expect(closeSettled).toBe(false);
        releaseJob();
        await closing;
        const client = createClient({ url: localRuntimeDbUrl(dataDir) });
        try {
            const jobs = await client.execute(
                "SELECT status, result_json FROM async_jobs WHERE child_session_id = 'child-close-drain' ORDER BY rowid",
            );
            expect(jobs.rows).toEqual(
                expect.arrayContaining([
                    {
                        status: 'completed',
                        result_json: '{"status":"completed","output":"close drained output"}',
                    },
                ]),
            );
        } finally {
            client.close();
        }
    });
});
