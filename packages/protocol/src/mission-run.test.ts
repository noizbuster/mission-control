import { describe, expect, it } from 'vitest';
import { MissionSchema, RUN_STATUSES, type Run, RunSchema } from './mission-run.js';

const minimalGraph = {
    id: 'graph-1',
    entryNodeId: 'n1',
    nodes: [{ id: 'n1', kind: 'llm' }],
};

describe('Mission schema (Phase 7)', () => {
    it('parses a Mission with an inline graph and defaults', () => {
        const mission = MissionSchema.parse({
            id: 'mission-1',
            name: 'Echo Agent',
            createdAt: '2026-06-16T00:00:00.000Z',
            updatedAt: '2026-06-16T00:00:00.000Z',
            graph: minimalGraph,
        });
        expect(mission.status).toBe('draft');
        expect(mission.version).toBe('1');
        expect(mission.capabilities.allow).toEqual([]);
        expect(mission.policies).toEqual([]);
        expect(mission.graph?.id).toBe('graph-1');
    });

    it('parses a Mission referencing a graphId with budget + capabilities', () => {
        const mission = MissionSchema.parse({
            id: 'mission-2',
            name: 'Coder',
            graphId: 'registered-coding-agent',
            capabilities: { allow: ['read', 'bash.run'], deny: ['file.write'] },
            budget: { budgetCents: 50, warnAtCents: 40 },
            createdAt: '2026-06-16T00:00:00.000Z',
            updatedAt: '2026-06-16T00:00:00.000Z',
        });
        expect(mission.graphId).toBe('registered-coding-agent');
        expect(mission.budget?.budgetCents).toBe(50);
    });

    it('rejects a Mission with neither graph nor graphId', () => {
        expect(() =>
            MissionSchema.parse({
                id: 'mission-x',
                name: 'Noop',
                createdAt: '2026-06-16T00:00:00.000Z',
                updatedAt: '2026-06-16T00:00:00.000Z',
            }),
        ).toThrow();
    });
});

describe('Run schema (Phase 7)', () => {
    it('parses a Run with defaults (pending, zero cost)', () => {
        const run: Run = RunSchema.parse({ id: 'run-1', missionId: 'mission-1' });
        expect(run.status).toBe('pending');
        expect(run.attempt).toBe(1);
        expect(run.cost.cents).toBe(0);
        expect(run.cost.modelCalls).toBe(0);
    });

    it('parses a terminal Run with accumulated cost', () => {
        const run = RunSchema.parse({
            id: 'run-2',
            missionId: 'mission-1',
            status: 'completed',
            sessionId: 'sess-1',
            cost: { cents: 12, inputTokens: 1000, outputTokens: 400, modelCalls: 3 },
            startedAt: '2026-06-16T00:00:00.000Z',
            endedAt: '2026-06-16T00:05:00.000Z',
        });
        expect(run.status).toBe('completed');
        expect(run.sessionId).toBe('sess-1');
        expect(run.cost.cents).toBe(12);
    });

    it('RUN_STATUSES covers the full lifecycle', () => {
        expect(RUN_STATUSES).toEqual(['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled']);
    });

    it('rejects an unknown Run status', () => {
        expect(() => RunSchema.parse({ id: 'run-3', missionId: 'm', status: 'exploded' })).toThrow();
    });
});
