import { afterEach, describe, expect, it } from 'vitest';
import {
    agentJobTestNow,
    cleanupAgentJobMirrorTests,
    insertAgentJobTestSession,
    withAgentJobMirror,
} from './agent-job-sql-mirror-test-support';
import { AsyncJobManager } from './async-job-manager';
import { RuntimeAgentRegistry } from './runtime-registry';

const testNow = agentJobTestNow;
const withMirror = withAgentJobMirror;
afterEach(cleanupAgentJobMirrorTests);

describe('SqlAgentJobMirror', () => {
    it('reopens runtime agent refs with lifecycle transitions intact', async () => {
        // Given
        await withMirror(async (mirror) => {
            const registry = new RuntimeAgentRegistry({ mirror });

            // When
            registry.adopt({
                id: 'agent-1',
                displayName: 'research child',
                kind: 'sub',
                parentId: 'Main',
                authorityFingerprint: 'authority-v1',
                status: 'running',
                sessionId: 'child-session-1',
                activity: 'researching',
            });
            registry.update('agent-1', {
                status: 'parked',
                lastActivity: '2026-07-06T00:00:00.000Z',
                sessionFile: '/tmp/child-session-1.jsonl',
            });
            await mirror.flush();

            // Then
            const loaded = await mirror.loadRuntimeAgents();
            const reopened = new RuntimeAgentRegistry({ initialRefs: loaded });
            const ref = reopened.lookup('agent-1');
            expect(ref?.status).toBe('parked');
            expect(ref?.sessionId).toBe('child-session-1');
            expect(ref?.displayName).toBe('research child');
            expect(ref?.sessionFile).toBe('/tmp/child-session-1.jsonl');
            expect(ref?.authorityFingerprint).toBe('authority-v1');
        });
    });

    it('round-trips taskDepth through runtime_agents.metadata_json', async () => {
        await withMirror(async (mirror) => {
            const registry = new RuntimeAgentRegistry({ mirror });
            registry.adopt({
                id: 'agent-depth',
                displayName: 'depth child',
                kind: 'sub',
                parentId: 'Main',
                authorityFingerprint: 'authority-depth',
                taskDepth: 2,
                status: 'running',
                sessionId: 'child-session-depth',
            });
            await mirror.flush();

            const loaded = await mirror.loadRuntimeAgents();
            const reopened = new RuntimeAgentRegistry({ initialRefs: loaded });
            const ref = reopened.lookup('agent-depth');
            expect(ref?.taskDepth).toBe(2);
            expect(ref?.authorityFingerprint).toBe('authority-depth');
        });
    });

    it('mirrors async jobs with parent-child lineage and yielded result output', async () => {
        // Given
        await withMirror(async (mirror) => {
            const manager = new AsyncJobManager(1, { mirror });

            // When
            const handle = manager.startJob({
                sessionId: 'child-session-2',
                parentSessionId: 'parent-session',
                agentId: 'agent-2',
                blocking: false,
                execute: async () => ({ status: 'completed', output: 'yielded child result' }),
            });
            const settled = await manager.awaitJob(handle.jobId);
            await mirror.flush();

            // Then
            expect(settled.status).toBe('completed');
            const loaded = await mirror.loadJobs();
            expect(loaded).toHaveLength(1);
            expect(loaded[0]?.parentSessionId).toBe('parent-session');
            expect(loaded[0]?.sessionId).toBe('child-session-2');
            expect(loaded[0]?.agentId).toBe('agent-2');
            expect(loaded[0]?.blocking).toBe(false);
            expect(loaded[0]?.result?.output).toBe('yielded child result');
        });
    });

    it('fails closed when reopened agent or job rows contain unknown statuses', async () => {
        // Given
        await withMirror(async (mirror) => {
            await insertAgentJobTestSession(mirror, 'bad-session');
            await mirror.client.execute({
                sql:
                    'INSERT INTO runtime_agents ' +
                    '(agent_id, kind, session_id, status, created_at, updated_at, metadata_json) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: ['bad-agent', 'sub', 'bad-session', 'waiting', testNow, testNow, '{"displayName":"bad"}'],
            });
            await mirror.client.execute({
                sql: 'INSERT INTO async_jobs (job_id, child_session_id, status, queued_at) VALUES (?, ?, ?, ?)',
                args: ['bad-job', 'bad-session', 'waiting', testNow],
            });

            // When
            const agents = await mirror.loadRuntimeAgents();
            const jobs = await mirror.loadJobs();

            // Then
            expect(agents).toEqual([]);
            expect(jobs).toEqual([]);
        });
    });

    it('allows raw client cleanup to null deleted session references', async () => {
        // Given
        await withMirror(async (mirror) => {
            await insertAgentJobTestSession(mirror, 'parent-delete');
            await insertAgentJobTestSession(mirror, 'child-delete');
            await mirror.client.batch([
                {
                    sql:
                        'INSERT INTO runtime_agents ' +
                        '(agent_id, kind, session_id, parent_agent_id, status, created_at, updated_at, metadata_json) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    args: [
                        'agent-delete',
                        'sub',
                        'child-delete',
                        'Main',
                        'running',
                        testNow,
                        testNow,
                        '{"displayName":"deleted child"}',
                    ],
                },
                {
                    sql:
                        'INSERT INTO async_jobs ' +
                        '(job_id, parent_session_id, child_session_id, agent_id, status, queued_at, started_at, metadata_json) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    args: [
                        'job-delete',
                        'parent-delete',
                        'child-delete',
                        'agent-delete',
                        'running',
                        testNow,
                        testNow,
                        '{"blocking":true}',
                    ],
                },
            ]);

            // When
            await mirror.client.execute({
                sql: 'UPDATE runtime_agents SET session_id = NULL WHERE session_id = ?',
                args: ['child-delete'],
            });
            await mirror.client.execute({
                sql: 'UPDATE async_jobs SET parent_session_id = NULL WHERE parent_session_id = ?',
                args: ['parent-delete'],
            });
            await mirror.client.execute({
                sql: 'UPDATE async_jobs SET child_session_id = NULL WHERE child_session_id = ?',
                args: ['child-delete'],
            });

            // Then
            const agentRows = await mirror.client.execute(
                "SELECT session_id FROM runtime_agents WHERE agent_id = 'agent-delete'",
            );
            const jobRows = await mirror.client.execute(
                "SELECT parent_session_id, child_session_id FROM async_jobs WHERE job_id = 'job-delete'",
            );
            expect(agentRows.rows).toEqual([{ session_id: null }]);
            expect(jobRows.rows).toEqual([{ parent_session_id: null, child_session_id: null }]);
        });
    });

    it('cancels active mirrored jobs during reopen recovery without reexecuting them', async () => {
        // Given
        await withMirror(async (mirror) => {
            mirror.recordJob({
                jobId: 'job-running',
                sessionId: 'child-running',
                parentSessionId: 'parent-session',
                status: 'running',
                startedAt: testNow,
            });
            await mirror.flush();

            // When
            const report = await mirror.recoverJobs();
            const [job] = await mirror.loadJobs();

            // Then
            expect(report).toEqual({ recovered: 1, cancelled: 1, preserved: 0 });
            expect(job?.status).toBe('cancelled');
            expect(job?.completedAt).toBeDefined();
            expect(job?.error).toContain('cancelled after');
        });
    });
});
