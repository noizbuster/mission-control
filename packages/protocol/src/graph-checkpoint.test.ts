import { describe, expect, it } from 'vitest';
import { GraphCheckpointSchema } from './abg';
import { AgentEventSchema } from './schema';

const minimalCheckpoint = {
    schemaVersion: 1,
    graphId: 'graph_resume',
    reason: 'node_boundary',
    queuedNodeIds: [],
    completedNodeIds: [],
    nodeStatuses: {},
    attemptsByNodeId: {},
    consecutiveFailuresByNodeId: {},
    consecutiveToolFailuresByNodeId: {},
    totalNodeRuns: 0,
    budgetExtensionsUsed: 0,
    maxNodeRuns: 1,
    blackboardEntries: {},
    activeParallelParentIds: [],
    createdAt: '2026-07-20T00:00:00.000Z',
};

describe('GraphCheckpointSchema', () => {
    it('round trips a minimal checkpoint and first-class graph checkpoint event', () => {
        const checkpoint = GraphCheckpointSchema.parse(minimalCheckpoint);
        const serialized = JSON.stringify(checkpoint);
        const event = AgentEventSchema.parse({
            type: 'graph.checkpoint',
            timestamp: '2026-07-20T00:00:00.000Z',
            sessionId: 'session_resume',
            abg: {
                graphId: 'graph_resume',
                checkpoint,
            },
        });

        expect(GraphCheckpointSchema.parse(JSON.parse(serialized))).toEqual(checkpoint);
        expect(event.type).toBe('graph.checkpoint');
        expect(event.abg?.checkpoint?.graphId).toBe('graph_resume');
    });

    it('rejects unknown checkpoint reasons', () => {
        const parsed = GraphCheckpointSchema.safeParse({
            ...minimalCheckpoint,
            reason: 'manual_save',
        });

        expect(parsed.success).toBe(false);
    });

    it('rejects node statuses outside the ABG node status vocabulary', () => {
        const parsed = GraphCheckpointSchema.safeParse({
            ...minimalCheckpoint,
            nodeStatuses: {
                classify: 'completed',
            },
        });

        expect(parsed.success).toBe(false);
    });

    it('accepts empty queued node ids at the schema boundary', () => {
        const checkpoint = GraphCheckpointSchema.parse({
            ...minimalCheckpoint,
            queuedNodeIds: [],
        });

        expect(checkpoint.queuedNodeIds).toEqual([]);
    });
});
