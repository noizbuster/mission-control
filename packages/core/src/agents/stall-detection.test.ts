import { describe, expect, it } from 'vitest';
import type { BackgroundJobHandle } from './async-job-manager';
import type { AgentRef } from './runtime-registry';
import {
    DEFAULT_STALL_THRESHOLD_MS,
    findStalledTargets,
    formatSilentDuration,
    isSilentLongerThan,
} from './stall-detection';

const NOW = Date.parse('2026-07-21T12:00:00.000Z');
const FRESH = '2026-07-21T11:58:00.000Z';
const STALE = '2026-07-21T11:50:00.000Z';

function agent(overrides: Partial<AgentRef> & Pick<AgentRef, 'id' | 'status' | 'lastActivity'>): AgentRef {
    return {
        displayName: overrides.displayName ?? overrides.id,
        kind: 'sub',
        sessionId: overrides.sessionId ?? `sess-${overrides.id}`,
        createdAt: STALE,
        ...overrides,
    };
}

function job(
    overrides: Partial<BackgroundJobHandle> & Pick<BackgroundJobHandle, 'jobId' | 'status' | 'startedAt'>,
): BackgroundJobHandle {
    return {
        sessionId: overrides.sessionId ?? `sess-${overrides.jobId}`,
        ...overrides,
    };
}

describe('isSilentLongerThan', () => {
    it('returns true when activity is older than the threshold', () => {
        expect(isSilentLongerThan(STALE, NOW, DEFAULT_STALL_THRESHOLD_MS)).toBe(true);
    });

    it('returns false when activity is within the threshold', () => {
        expect(isSilentLongerThan(FRESH, NOW, DEFAULT_STALL_THRESHOLD_MS)).toBe(false);
    });

    it('returns false for invalid timestamps', () => {
        expect(isSilentLongerThan('not-a-date', NOW, DEFAULT_STALL_THRESHOLD_MS)).toBe(false);
    });
});

describe('findStalledTargets', () => {
    it('includes running agents silent longer than the threshold', () => {
        const targets = findStalledTargets({
            nowMs: NOW,
            agents: [
                agent({ id: 'a1', status: 'running', lastActivity: STALE, displayName: 'deep' }),
                agent({ id: 'a2', status: 'running', lastActivity: FRESH }),
                agent({ id: 'a3', status: 'idle', lastActivity: STALE }),
            ],
        });

        expect(targets).toEqual([
            expect.objectContaining({
                kind: 'agent',
                id: 'a1',
                displayName: 'deep',
            }),
        ]);
    });

    it('includes running jobs silent longer than the threshold via startedAt', () => {
        const targets = findStalledTargets({
            nowMs: NOW,
            jobs: [
                job({ jobId: 'j1', status: 'running', startedAt: STALE }),
                job({ jobId: 'j2', status: 'running', startedAt: FRESH }),
                job({ jobId: 'j3', status: 'completed', startedAt: STALE }),
            ],
        });

        expect(targets).toEqual([
            expect.objectContaining({
                kind: 'job',
                jobId: 'j1',
            }),
        ]);
    });

    it('prefers matching agent lastActivity over job startedAt', () => {
        const targets = findStalledTargets({
            nowMs: NOW,
            agents: [agent({ id: 'a1', status: 'running', lastActivity: FRESH, sessionId: 'sess-shared' })],
            jobs: [job({ jobId: 'j1', status: 'running', startedAt: STALE, sessionId: 'sess-shared' })],
        });

        expect(targets.some((t) => t.kind === 'job')).toBe(false);
        expect(targets.some((t) => t.kind === 'agent')).toBe(false);
    });

    it('includes a stalled main turn when last packet is old', () => {
        const targets = findStalledTargets({
            nowMs: NOW,
            mainLastPacketAt: STALE,
        });

        expect(targets).toEqual([
            expect.objectContaining({
                kind: 'main_turn',
                lastPacketAt: STALE,
            }),
        ]);
    });

    it('returns empty when nothing is stalled', () => {
        expect(
            findStalledTargets({
                nowMs: NOW,
                agents: [agent({ id: 'a1', status: 'running', lastActivity: FRESH })],
                jobs: [job({ jobId: 'j1', status: 'running', startedAt: FRESH })],
                mainLastPacketAt: FRESH,
            }),
        ).toEqual([]);
    });
});

describe('formatSilentDuration', () => {
    it('formats seconds, minutes, and hours', () => {
        expect(formatSilentDuration(45_000)).toBe('45s');
        expect(formatSilentDuration(125_000)).toBe('2m 5s');
        expect(formatSilentDuration(3_720_000)).toBe('1h 2m');
    });
});
