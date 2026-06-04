import { describe, expect, it } from 'vitest';
import { collectSignals, createCompositeNodeTestContext as context } from './composite-node-test-helpers.js';
import { runAbgNode } from './node-registry.js';

describe('ABG watch and statechart nodes', () => {
    it('watch redirects on matching events', async () => {
        const runContext = {
            ...context(),
            observedEvents: [
                {
                    type: 'user.cancel',
                },
            ],
        };

        const signals = await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'watch-cancel',
                    kind: 'watch',
                    config: {
                        eventType: 'user.cancel',
                        target: 'cancel-run',
                    },
                },
                runContext,
            ),
        );

        expect(signals.map((signal) => signal.type)).toEqual(['started', 'select', 'success']);
        expect(signals[1]).toMatchObject({
            type: 'select',
            target: 'cancel-run',
        });
    });

    it('watch emits cancel on user cancel and redirects policy blocks', async () => {
        const cancelContext = {
            ...context(),
            observedEvents: [
                {
                    type: 'user.cancel',
                },
            ],
        };
        const policyContext = {
            ...context(),
            observedEvents: [
                {
                    type: 'policy.blocked',
                },
            ],
        };

        const cancelSignals = await collectSignals(
            runAbgNode(
                cancelContext.registry,
                {
                    id: 'watch-cancel-signal',
                    kind: 'watch',
                    config: {
                        eventType: 'user.cancel',
                        cancelTarget: 'active-tool',
                    },
                },
                cancelContext,
            ),
        );
        const policySignals = await collectSignals(
            runAbgNode(
                policyContext.registry,
                {
                    id: 'watch-policy-block',
                    kind: 'watch',
                    config: {
                        eventType: 'policy.blocked',
                        target: 'human-review',
                    },
                },
                policyContext,
            ),
        );

        expect(cancelSignals).toContainEqual({
            type: 'cancel',
            graphId: 'graph_composite',
            nodeId: 'watch-cancel-signal',
            target: 'active-tool',
            reason: 'matched event user.cancel',
        });
        expect(policySignals[1]).toMatchObject({
            type: 'select',
            target: 'human-review',
        });
    });

    it('statechart emits transition signals', async () => {
        const runContext = context();

        const signals = await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'code-edit-flow',
                    kind: 'statechart',
                    config: {
                        from: 'inspect',
                        to: 'patch',
                    },
                },
                runContext,
            ),
        );

        expect(signals).toContainEqual({
            type: 'transition',
            graphId: 'graph_composite',
            nodeId: 'code-edit-flow',
            from: 'inspect',
            to: 'patch',
        });
    });

    it('statechart consumes observed events for transitions', async () => {
        const runContext = {
            ...context(),
            observedEvents: [
                {
                    type: 'review.approved',
                },
            ],
        };

        const signals = await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'approval-flow',
                    kind: 'statechart',
                    config: {
                        initial: 'review',
                        transitions: [
                            {
                                eventType: 'review.approved',
                                from: 'review',
                                to: 'execute',
                            },
                        ],
                    },
                },
                runContext,
            ),
        );

        expect(signals).toContainEqual({
            type: 'transition',
            graphId: 'graph_composite',
            nodeId: 'approval-flow',
            from: 'review',
            to: 'execute',
        });
    });
});
