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
                'SELECT session_id, parent_session_id FROM sessions WHERE session_id IN (?, ?) ORDER BY session_id',
                ['child-bg', 'child-fg'],
            );
            expect(rows.rows).toEqual([
                { session_id: 'child-bg', parent_session_id: 'parent-session' },
                { session_id: 'child-fg', parent_session_id: 'parent-session' },
            ]);
        });
    });
});
