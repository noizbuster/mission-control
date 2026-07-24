import { afterEach, describe, expect, it } from 'vitest';
import { deriveSessionLifecycle } from '../memory/session-status-derivation';
import { cleanupAgentJobMirrorTests, withAgentJobMirror } from './agent-job-sql-mirror-test-support';

afterEach(cleanupAgentJobMirrorTests);

describe('SqlAgentJobMirror lifecycle', () => {
    it('marks only synchronous child work as awaiting/subagent', async () => {
        await withAgentJobMirror(async (mirror) => {
            mirror.recordJob({
                jobId: 'job-detached',
                sessionId: 'child-bg',
                parentSessionId: 'parent-session',
                agentId: 'agent-bg',
                blocking: false,
                status: 'running',
                startedAt: '2026-07-06T00:00:00.000Z',
            });
            await mirror.startSubagentWait({
                parentSessionId: 'parent-session',
                childSessionId: 'child-fg',
                agentId: 'agent-fg',
                mode: 'sync',
            });
            await mirror.flush();

            const lifecycle = deriveSessionLifecycle({
                terminalEvent: { kind: 'none' },
                activeRuns: [],
                pendingWaits: await mirror.loadPendingWaits('parent-session'),
                backgroundJobs: await mirror.loadBackgroundJobsForParent('parent-session'),
            });
            expect(lifecycle).toEqual({
                status: 'awaiting',
                awaitingReason: 'subagent',
                displayReason: 'awaiting subagent',
                primaryWaitId: 'child-fg',
            });

            await mirror.resolveSubagentWait({
                parentSessionId: 'parent-session',
                childSessionId: 'child-fg',
                status: 'completed',
                output: 'foreground result',
            });
            await mirror.flush();
            const afterResolve = deriveSessionLifecycle({
                terminalEvent: { kind: 'none' },
                activeRuns: [],
                pendingWaits: await mirror.loadPendingWaits('parent-session'),
                backgroundJobs: await mirror.loadBackgroundJobsForParent('parent-session'),
            });
            expect(afterResolve.status).toBe('running');
        });
    });

    it('records child parent_session_id for foreground and background children', async () => {
        await withAgentJobMirror(async (mirror) => {
            mirror.recordJob({
                jobId: 'job-detached',
                sessionId: 'child-bg',
                parentSessionId: 'parent-session',
                agentId: 'agent-bg',
                blocking: false,
                status: 'running',
                startedAt: '2026-07-06T00:00:00.000Z',
            });
            await mirror.startSubagentWait({
                parentSessionId: 'parent-session',
                childSessionId: 'child-fg',
                agentId: 'agent-fg',
                mode: 'sync',
            });
            await mirror.flush();

            const rows = await mirror.client.execute(
                'SELECT session_id, parent_session_id, status FROM sessions WHERE session_id IN (?, ?) ORDER BY session_id',
                ['child-bg', 'child-fg'],
            );
            expect(rows.rows).toEqual([
                { session_id: 'child-bg', parent_session_id: 'parent-session', status: 'running' },
                { session_id: 'child-fg', parent_session_id: 'parent-session', status: 'running' },
            ]);
        });
    });

    it('settles child session status on foreground resolve', async () => {
        await withAgentJobMirror(async (mirror) => {
            await mirror.startSubagentWait({
                parentSessionId: 'parent-session',
                childSessionId: 'child-fg',
                agentId: 'agent-fg',
                mode: 'sync',
            });
            await mirror.resolveSubagentWait({
                parentSessionId: 'parent-session',
                childSessionId: 'child-fg',
                status: 'completed',
                output: 'done',
            });
            await mirror.flush();

            const rows = await mirror.client.execute('SELECT session_id, status FROM sessions WHERE session_id = ?', [
                'child-fg',
            ]);
            expect(rows.rows).toEqual([{ session_id: 'child-fg', status: 'idle' }]);
        });
    });
});

describe('SqlAgentJobMirror child failure persistence', () => {
    it('persists a foreground child graph failure on the synchronous job record', async () => {
        await withAgentJobMirror(async (mirror) => {
            await mirror.startSubagentWait({
                parentSessionId: 'parent-session',
                childSessionId: 'child-failed',
                agentId: 'agent-fg',
                mode: 'sync',
            });
            await mirror.resolveSubagentWait({
                parentSessionId: 'parent-session',
                childSessionId: 'child-failed',
                status: 'failed',
                output: '[degraded salvage] partial child output',
                failure: {
                    code: 'provider_aborted',
                    message: 'remote provider closed the child stream',
                    retryable: false,
                },
            });
            await mirror.flush();

            const jobs = await mirror.loadBackgroundJobsForParent('parent-session');

            expect(jobs).toContainEqual({
                jobId: 'child-failed',
                blocking: true,
                status: 'failed',
                childSessionId: 'child-failed',
            });
            const loaded = await mirror.loadJobs();
            expect(loaded.find((job) => job.jobId === 'child-failed')?.result?.failure).toEqual({
                code: 'provider_aborted',
                message: 'remote provider closed the child stream',
                retryable: false,
            });
        });
    });
});
