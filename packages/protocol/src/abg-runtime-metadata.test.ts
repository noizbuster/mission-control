import { describe, expect, it } from 'vitest';
import { AbgGraphSnapshotSchema, AbgGraphSpecSchema, AbgPolicyDecisionSchema } from './abg.js';
import { AgentEventSchema } from './schema.js';

describe('ABG runtime metadata protocol schemas', () => {
    it('parses coordinator policy decisions, loop limits, and attempt metadata', () => {
        const graph = AbgGraphSpecSchema.parse({
            id: 'approval-graph',
            entryNodeId: 'approve-patch',
            defaults: {
                maxNodeRuns: 3,
            },
            nodes: [
                {
                    id: 'approve-patch',
                    kind: 'human-approval',
                },
            ],
            policies: [
                {
                    id: 'patch-approval',
                    capability: 'file.patch',
                    decision: 'requires_approval',
                },
            ],
        });
        const limitEvent = AgentEventSchema.parse({
            type: 'graph.failed',
            timestamp: '2026-06-03T10:00:00.000Z',
            sessionId: 'session_abg',
            message: 'ABG graph loop limit exceeded',
            abg: {
                graphId: 'approval-graph',
                attempt: 3,
                maxAttempts: 3,
                error: {
                    code: 'graph_loop_limit',
                    message: 'ABG graph loop limit exceeded',
                    retryable: false,
                },
            },
        });
        const attemptEvent = AgentEventSchema.parse({
            type: 'attempt.started',
            timestamp: '2026-06-03T10:00:00.000Z',
            sessionId: 'session_abg',
            message: 'attempt started: approve-patch#3',
            durability: 'durable',
            abg: {
                graphId: 'approval-graph',
                nodeId: 'approve-patch',
                attempt: 3,
                maxAttempts: 3,
            },
        });

        expect(AbgPolicyDecisionSchema.parse('requires_approval')).toBe('requires_approval');
        expect(graph.defaults?.maxNodeRuns).toBe(3);
        expect(graph.policies[0]?.decision).toBe('requires_approval');
        expect(limitEvent.abg?.error?.code).toBe('graph_loop_limit');
        expect(attemptEvent.durability).toBe('durable');
        expect(attemptEvent.abg?.attempt).toBe(3);
    });

    it('normalizes legacy requires-approval policy spelling for authorable graph compatibility', () => {
        const graph = AbgGraphSpecSchema.parse({
            id: 'legacy-approval-graph',
            entryNodeId: 'approve-patch',
            nodes: [
                {
                    id: 'approve-patch',
                    kind: 'human-approval',
                },
            ],
            policies: [
                {
                    id: 'patch-approval',
                    capability: 'file.patch',
                    decision: 'requires-approval',
                },
            ],
            rules: [
                {
                    id: 'approval-rule',
                    when: {
                        kind: 'policy.decision.equals',
                        decision: 'requires-approval',
                    },
                },
            ],
        });

        expect(graph.policies[0]?.decision).toBe('requires_approval');
        expect(graph.rules[0]?.when).toEqual({
            kind: 'policy.decision.equals',
            decision: 'requires_approval',
        });
    });

    it('parses graph snapshots with approval and tool outcome projections', () => {
        const snapshot = AbgGraphSnapshotSchema.parse({
            graphId: 'coding-agent',
            status: 'completed',
            activeNodeIds: [],
            nodes: [
                {
                    nodeId: 'approval',
                    status: 'succeeded',
                },
            ],
            approvals: [
                {
                    approvalId: 'approval_permission-coding-agent-approval',
                    requestId: 'permission-coding-agent-approval',
                    policyDecision: 'requires_approval',
                    state: 'approved',
                    subject: { kind: 'node', id: 'approval' },
                    requestedAt: '2026-06-09T00:00:00.000Z',
                    decidedAt: '2026-06-09T00:00:00.000Z',
                    reason: 'approved by fixture',
                },
            ],
            toolOutcomes: [
                {
                    toolId: 'test-typecheck',
                    status: 'completed',
                    completedAt: '2026-06-09T00:00:00.000Z',
                    lastMessage: 'tool completed: test-typecheck',
                },
            ],
        });

        expect(snapshot.approvals.map((approval) => approval.state)).toEqual(['approved']);
        expect(snapshot.toolOutcomes.map((tool) => tool.toolId)).toEqual(['test-typecheck']);
    });
});
