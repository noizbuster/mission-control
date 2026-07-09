import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { projectTuiRuntimeEvents } from './index.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const laterTimestamp = '2026-01-01T00:00:01.000Z';
const latestTimestamp = '2026-01-01T00:00:02.000Z';

function runEvent(): AgentEvent {
    return { type: 'run.started', timestamp };
}

function graphEvent(type: 'graph.started' | 'graph.completed', graphId: string): AgentEvent {
    return { type, timestamp, abg: { graphId } };
}

function toolStartedEvent(): AgentEvent {
    return {
        type: 'tool.started',
        timestamp,
        taskId: 'tool-1',
        message: 'starting tool',
    };
}

function toolCompletedEvent(): AgentEvent {
    return {
        type: 'tool.completed',
        timestamp: laterTimestamp,
        taskId: 'tool-1',
        message: 'tool complete',
        toolResult: {
            toolCallId: 'tool-1',
            status: 'completed',
            output: 'ok',
        },
    };
}

function approvalEvent(
    state: 'pending' | 'approved',
    eventType: 'approval.requested' | 'approval.updated',
): AgentEvent {
    return {
        type: eventType,
        timestamp: state === 'pending' ? timestamp : latestTimestamp,
        approvalRecord: {
            approvalId: 'approval-1',
            requestId: 'request-1',
            policyDecision: 'requires_approval',
            state,
            subject: { kind: 'tool', id: 'tool-1' },
            requestedAt: timestamp,
            ...(state === 'approved' ? { decidedAt: latestTimestamp } : {}),
        },
    };
}

describe('projectTuiRuntimeEvents', () => {
    it('deduplicates live events and derives tool, approval, timeline, graph, and session projections', () => {
        const projection = projectTuiRuntimeEvents({
            sessionId: 'projection-session',
            events: [
                runEvent(),
                runEvent(),
                graphEvent('graph.started', 'graph-1'),
                toolStartedEvent(),
                toolCompletedEvent(),
                toolCompletedEvent(),
                approvalEvent('pending', 'approval.requested'),
                approvalEvent('approved', 'approval.updated'),
                { type: 'not.a.real.event', timestamp },
            ],
        });

        expect(projection.events.map((event) => event.type)).toEqual([
            'run.started',
            'graph.started',
            'tool.started',
            'tool.completed',
            'approval.requested',
            'approval.updated',
        ]);
        expect(projection.toolOutcomes).toEqual([
            {
                toolId: 'tool-1',
                status: 'completed',
                startedAt: timestamp,
                completedAt: laterTimestamp,
                lastMessage: 'tool complete',
                result: { toolCallId: 'tool-1', status: 'completed', output: 'ok' },
            },
        ]);
        expect(projection.approvals).toHaveLength(1);
        expect(projection.approvals[0]?.state).toBe('approved');
        expect(projection.approvals[0]?.updatedAt).toBe(latestTimestamp);
        expect(projection.timeline.map((entry) => entry.type)).toEqual(['graph.started']);
        expect(projection.graphSnapshots).toMatchObject([{ graphId: 'graph-1', status: 'active' }]);
        expect(projection.session).toMatchObject({ id: 'projection-session', status: 'running' });
    });

    it('keeps out-of-order graph and approval projections deterministic', () => {
        const projection = projectTuiRuntimeEvents({
            sessionId: 'projection-session',
            events: [
                graphEvent('graph.completed', 'graph-1'),
                graphEvent('graph.started', 'graph-1'),
                approvalEvent('approved', 'approval.updated'),
                approvalEvent('pending', 'approval.requested'),
            ],
        });

        expect(projection.graphSnapshots).toMatchObject([{ graphId: 'graph-1', status: 'active' }]);
        expect(projection.approvals).toHaveLength(1);
        expect(projection.approvals[0]?.state).toBe('pending');
        expect(projection.events.map((event) => event.type)).toEqual([
            'graph.completed',
            'graph.started',
            'approval.updated',
            'approval.requested',
        ]);
    });
});
