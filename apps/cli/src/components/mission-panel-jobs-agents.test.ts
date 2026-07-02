import { type AgentRef, AsyncJobManager, type BackgroundJobHandle, RuntimeAgentRegistry } from '@mission-control/core';
import { describe, expect, it } from 'vitest';
import {
    agentStatusColor,
    buildAgentPanelRows,
    buildJobPanelRows,
    formatPanelTimestamp,
    jobStatusColor,
    truncatePanelId,
} from './mission-panel-rows.js';

function makeJob(
    overrides: Partial<BackgroundJobHandle> & Pick<BackgroundJobHandle, 'jobId' | 'status'>,
): BackgroundJobHandle {
    return {
        sessionId: 'sess-default',
        startedAt: '2026-07-02T13:45:00.000Z',
        ...overrides,
    };
}

function makeAgent(overrides: Partial<AgentRef> & Pick<AgentRef, 'id' | 'status'>): AgentRef {
    return {
        displayName: 'Researcher',
        kind: 'sub',
        sessionId: 'sess-default',
        createdAt: '2026-07-02T13:45:00.000Z',
        lastActivity: '2026-07-02T13:46:00.000Z',
        ...overrides,
    };
}

describe('buildJobPanelRows', () => {
    it('projects a queued job with start timestamp and no end detail', () => {
        const rows = buildJobPanelRows([makeJob({ jobId: 'job_abc123_long', status: 'queued' })]);

        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row?.id).toBe('job_abc123_long');
        expect(row?.status).toBe('queued');
        expect(row?.label).toContain('job_abc123_long');
        expect(row?.label).toContain('sess-default');
        expect(row?.detail).toBe('start 13:45:00');
        expect(row?.error).toBeUndefined();
    });

    it('projects a running job and omits detail when only start is known', () => {
        const rows = buildJobPanelRows([makeJob({ jobId: 'job_running', status: 'running' })]);

        expect(rows[0]?.status).toBe('running');
        expect(rows[0]?.detail).toBe('start 13:45:00');
    });

    it('projects a completed job with start and end timestamps joined by a middle dot', () => {
        const rows = buildJobPanelRows([
            makeJob({ jobId: 'job_done', status: 'completed', completedAt: '2026-07-02T13:50:30.000Z' }),
        ]);

        expect(rows[0]?.status).toBe('completed');
        expect(rows[0]?.detail).toBe('start 13:45:00 \u00b7 end 13:50:30');
        expect(rows[0]?.error).toBeUndefined();
    });

    it('projects a failed job carrying the error message', () => {
        const rows = buildJobPanelRows([
            makeJob({
                jobId: 'job_fail',
                status: 'failed',
                completedAt: '2026-07-02T13:46:00.000Z',
                error: 'provider rate limit exceeded',
            }),
        ]);

        expect(rows[0]?.status).toBe('failed');
        expect(rows[0]?.error).toBe('provider rate limit exceeded');
    });

    it('projects a cancelled job without an error line', () => {
        const rows = buildJobPanelRows([
            makeJob({ jobId: 'job_cancel', status: 'cancelled', completedAt: '2026-07-02T13:46:00.000Z' }),
        ]);

        expect(rows[0]?.status).toBe('cancelled');
        expect(rows[0]?.error).toBeUndefined();
    });

    it('omits detail when timestamps cannot be parsed', () => {
        const rows = buildJobPanelRows([makeJob({ jobId: 'job_short', status: 'queued', startedAt: 'soon' })]);

        expect(rows[0]?.detail).toBeUndefined();
    });

    it('returns an empty array for no jobs (empty-state input)', () => {
        expect(buildJobPanelRows([])).toEqual([]);
    });
});

describe('buildAgentPanelRows', () => {
    it('projects a running agent using its activity hint as detail', () => {
        const rows = buildAgentPanelRows([
            makeAgent({ id: 'agent-1', status: 'running', activity: 'reading repo.read' }),
        ]);

        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row?.id).toBe('agent-1');
        expect(row?.status).toBe('running');
        expect(row?.label).toContain('agent-1');
        expect(row?.label).toContain('Researcher');
        expect(row?.detail).toBe('reading repo.read');
    });

    it('falls back to the agent kind when no activity is set', () => {
        const rows = buildAgentPanelRows([makeAgent({ id: 'agent-2', status: 'idle' })]);

        expect(rows[0]?.detail).toBe('sub');
    });

    it('projects a parked and an aborted agent', () => {
        const rows = buildAgentPanelRows([
            makeAgent({ id: 'agent-p', status: 'parked', sessionFile: '/tmp/s.jsonl' }),
            makeAgent({ id: 'agent-a', status: 'aborted' }),
        ]);

        expect(rows[0]?.status).toBe('parked');
        expect(rows[1]?.status).toBe('aborted');
    });

    it('returns an empty array for no agents (empty-state input)', () => {
        expect(buildAgentPanelRows([])).toEqual([]);
    });
});

describe('jobStatusColor / agentStatusColor', () => {
    it('maps each job status to a distinct color', () => {
        expect(jobStatusColor('completed')).toBe('#26d926');
        expect(jobStatusColor('failed')).toBe('#ff6b6b');
        expect(jobStatusColor('cancelled')).toBe('#ff6b6b');
        expect(jobStatusColor('running')).toBe('#00ffff');
        expect(jobStatusColor('queued')).toBe('#ffaa00');
        expect(jobStatusColor('unknown')).toBe('#aaaaaa');
    });

    it('maps each agent status to a distinct color', () => {
        expect(agentStatusColor('running')).toBe('#00ffff');
        expect(agentStatusColor('idle')).toBe('#26d926');
        expect(agentStatusColor('parked')).toBe('#ffaa00');
        expect(agentStatusColor('aborted')).toBe('#ff6b6b');
        expect(agentStatusColor('unknown')).toBe('#aaaaaa');
    });
});

describe('truncatePanelId / formatPanelTimestamp', () => {
    it('truncates ids longer than the limit with an ellipsis', () => {
        const long = 'job_1234567890abcdef';
        expect(truncatePanelId(long)).toBe('job_1234567890abcd\u2026');
        expect(truncatePanelId('short')).toBe('short');
    });

    it('respects an explicit limit', () => {
        expect(truncatePanelId('abcdef', 3)).toBe('abc\u2026');
    });

    it('extracts the time component of an ISO timestamp', () => {
        expect(formatPanelTimestamp('2026-07-02T13:45:00.000Z')).toBe('13:45:00');
    });

    it('returns undefined for absent or malformed timestamps', () => {
        expect(formatPanelTimestamp(undefined)).toBeUndefined();
        expect(formatPanelTimestamp('short')).toBeUndefined();
        expect(formatPanelTimestamp('2026-07-02_no_time_here_________')).toBeUndefined();
    });
});

describe('integration with real managers', () => {
    it('builds agent rows from RuntimeAgentRegistry.listVisibleTo', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAgent({ id: 'sub-a', status: 'idle', displayName: 'Planner' }));
        registry.adopt(makeAgent({ id: 'sub-b', status: 'running', displayName: 'Critic', activity: 'verifying' }));

        const rows = buildAgentPanelRows(registry.listVisibleTo('Main'));

        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.id)).toEqual(['sub-a', 'sub-b']);
        expect(rows[1]?.detail).toBe('verifying');
    });

    it('excludes advisors and the caller from the visible roster', () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeAgent({ id: 'sub-a', status: 'idle' }));
        registry.adopt(makeAgent({ id: 'adv-1', status: 'idle', kind: 'advisor' }));
        // Main is never adopted (adopt is a no-op for MAIN_AGENT_ID).

        const rows = buildAgentPanelRows(registry.listVisibleTo('Main'));

        expect(rows.map((r) => r.id)).toEqual(['sub-a']);
    });

    it('builds job rows from AsyncJobManager.listJobs after completion and failure', async () => {
        const manager = new AsyncJobManager(4);
        const completedHandle = manager.startJob({
            sessionId: 'sess-ok',
            execute: async () => ({ status: 'completed', output: 'ok' }),
        });
        const failedHandle = manager.startJob({
            sessionId: 'sess-bad',
            execute: async () => {
                throw new Error('boom');
            },
        });

        await manager.awaitJob(completedHandle.jobId);
        await manager.awaitJob(failedHandle.jobId);

        const rows = buildJobPanelRows(manager.listJobs());
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(completedHandle.jobId)?.status).toBe('completed');
        expect(byId.get(completedHandle.jobId)?.error).toBeUndefined();
        expect(byId.get(failedHandle.jobId)?.status).toBe('failed');
        expect(byId.get(failedHandle.jobId)?.error).toBe('boom');
    });

    it('renders a queued job that never obtained a slot', async () => {
        const manager = new AsyncJobManager(1);
        // Block the single slot with a job that never resolves on its own.
        let releaseBlocking: () => void = () => undefined;
        manager.startJob({
            sessionId: 'sess-blocker',
            execute: () =>
                new Promise<{ status: 'completed'; output: string }>((resolve) => {
                    releaseBlocking = () => resolve({ status: 'completed', output: '' });
                }),
        });
        const queuedHandle = manager.startJob({
            sessionId: 'sess-queued',
            execute: async () => ({ status: 'completed', output: 'queued-ran' }),
        });

        const rowsBefore = buildJobPanelRows(manager.listJobs());
        expect(rowsBefore.find((r) => r.id === queuedHandle.jobId)?.status).toBe('queued');

        releaseBlocking();
        await manager.awaitJob(queuedHandle.jobId);
    });
});
