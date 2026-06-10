import { describe, expect, it } from 'vitest';
import {
    approvalGraph,
    approvalInputEvent,
    createConcurrencyProbe,
    drainMicrotasks,
    fanOutGraph,
    waitingMessages,
} from './graph-coordinator-test-support.js';
import { runAbgGraph } from './graph-runner.js';
import { createDefaultAbgNodeRegistry } from './node-registry.js';

const baseInput = {
    sessionId: 'session_graph_approval_concurrency',
    now: () => '2026-06-09T00:00:00.000Z',
    modelProviderSelection: {
        providerID: 'local',
        modelID: 'local-echo',
    },
} as const;

describe('bounded ABG graph approval gates and concurrency', () => {
    it('blocks a human approval node until an approved decision event exists', async () => {
        const blocked = await runAbgGraph({
            ...baseInput,
            graph: approvalGraph('approval-blocked'),
        });
        const resumed = await runAbgGraph({
            ...baseInput,
            graph: approvalGraph('approval-resumed'),
            graphInput: {
                events: [
                    {
                        id: 'approval_decided',
                        type: 'approval.updated',
                        source: 'human',
                        timestamp: '2026-06-09T00:00:00.000Z',
                        payload: {
                            approvalId: 'approval_permission_approval-resumed_approve',
                            state: 'approved',
                            reason: 'approved by reviewer',
                        },
                    },
                ],
            },
        });

        expect(blocked.status).toBe('blocked');
        expect(blocked.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.requested', 'policy.blocked', 'graph.failed']),
        );
        expect(blocked.events.find((event) => event.type === 'approval.requested')?.approvalRecord).toMatchObject({
            approvalId: 'approval_permission_approval-blocked_approve',
            state: 'pending',
            subject: { kind: 'node', id: 'approve' },
        });
        expect(resumed.status).toBe('completed');
        expect(resumed.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.resumed', 'node.completed', 'graph.completed']),
        );
    });

    it('does not resume from non-decision approval events with approved-looking payloads', async () => {
        const requestedEvent = await runAbgGraph({
            ...baseInput,
            graph: approvalGraph('approval-requested-is-not-decision'),
            graphInput: {
                events: [
                    approvalInputEvent({
                        graphId: 'approval-requested-is-not-decision',
                        eventType: 'approval.requested',
                        state: 'approved',
                    }),
                ],
            },
        });
        const auditEvent = await runAbgGraph({
            ...baseInput,
            graph: approvalGraph('approval-audit-is-not-decision'),
            graphInput: {
                events: [
                    approvalInputEvent({
                        graphId: 'approval-audit-is-not-decision',
                        eventType: 'approval.audit',
                        state: 'approved',
                    }),
                ],
            },
        });

        expect(requestedEvent.status).toBe('blocked');
        expect(auditEvent.status).toBe('blocked');
        expect(requestedEvent.events.map((event) => event.type)).not.toContain('approval.resumed');
        expect(auditEvent.events.map((event) => event.type)).not.toContain('approval.resumed');
        expect(
            requestedEvent.events.find((event) => event.type === 'approval.requested')?.approvalRecord,
        ).toMatchObject({
            state: 'pending',
        });
        expect(auditEvent.events.find((event) => event.type === 'approval.requested')?.approvalRecord).toMatchObject({
            state: 'pending',
        });
    });

    it('enforces graph node concurrency default two and records waiting decisions', async () => {
        const probe = createConcurrencyProbe();
        const registry = createDefaultAbgNodeRegistry();
        registry.register('controlled-action', probe.runner);

        const run = runAbgGraph({
            ...baseInput,
            registry,
            graph: fanOutGraph({
                id: 'graph-concurrency',
                childKind: 'action',
                implementation: 'controlled-action',
                childCount: 3,
            }),
        });
        await probe.firstStarted;
        await drainMicrotasks();
        probe.release();
        const result = await run;

        expect(result.status).toBe('completed');
        expect(probe.maxActive()).toBe(2);
        expect(probe.startedNodeIds().slice(0, 2)).toEqual(['child-1', 'child-2']);
        expect(waitingMessages(result.events)).toContain('node waiting: child-3 (graph concurrency limit 2)');
    });

    it('enforces provider tool call concurrency default four independently of graph capacity', async () => {
        const probe = createConcurrencyProbe();
        const registry = createDefaultAbgNodeRegistry();
        registry.register('controlled-tool', probe.runner);

        const run = runAbgGraph({
            ...baseInput,
            graphNodeConcurrency: 8,
            registry,
            graph: fanOutGraph({
                id: 'provider-tool-concurrency',
                childKind: 'tool',
                implementation: 'controlled-tool',
                childCount: 5,
            }),
        });
        await probe.firstStarted;
        await drainMicrotasks();
        probe.release();
        const result = await run;

        expect(result.status).toBe('completed');
        expect(probe.maxActive()).toBe(4);
        expect(waitingMessages(result.events)).toContain(
            'node waiting: child-5 (provider tool call concurrency limit 4)',
        );
    });

    it('enforces shell concurrency default one for command tool nodes', async () => {
        const probe = createConcurrencyProbe();
        const registry = createDefaultAbgNodeRegistry();
        registry.register('controlled-shell', probe.runner);

        const run = runAbgGraph({
            ...baseInput,
            graphNodeConcurrency: 4,
            registry,
            graph: fanOutGraph({
                id: 'shell-concurrency',
                childKind: 'tool',
                implementation: 'controlled-shell',
                childCount: 2,
                capabilities: ['command.run'],
            }),
        });
        await probe.firstStarted;
        await drainMicrotasks();
        probe.release();
        const result = await run;

        expect(result.status).toBe('completed');
        expect(probe.maxActive()).toBe(1);
        expect(waitingMessages(result.events)).toContain('node waiting: child-2 (shell concurrency limit 1)');
    });
});
