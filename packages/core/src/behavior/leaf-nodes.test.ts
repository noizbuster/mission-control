import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    type AbgNodeRunContext,
    createAbgNodeRegistry,
    createDefaultAbgNodeRegistry,
    runAbgNode,
} from './node-registry.js';

async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

const context = {
    graphId: 'graph_leaf',
    now: () => '2026-06-03T10:00:00.000Z',
} satisfies AbgNodeRunContext;

describe('ABG leaf nodes', () => {
    it('llm node emits model metadata', async () => {
        const registry = createDefaultAbgNodeRegistry();

        const signals = await collectSignals(
            runAbgNode(
                registry,
                {
                    id: 'draft-answer',
                    kind: 'llm',
                    model: {
                        providerID: 'local',
                        modelID: 'local-echo',
                        variantID: 'default',
                        role: 'responder',
                    },
                },
                context,
            ),
        );

        expect(signals.map((signal) => signal.type)).toEqual(['started', 'progress', 'success']);
        expect(signals[1]).toMatchObject({
            type: 'progress',
            data: {
                model: {
                    providerID: 'local',
                    modelID: 'local-echo',
                    variantID: 'default',
                },
            },
        });
    });

    it('policy node blocks destructive capability', async () => {
        const registry = createDefaultAbgNodeRegistry();

        const signals = await collectSignals(
            runAbgNode(
                registry,
                {
                    id: 'check-delete',
                    kind: 'policy',
                    capabilities: ['file.delete'],
                },
                {
                    ...context,
                    policies: [
                        {
                            id: 'destructive-files',
                            capability: 'file.delete',
                            decision: 'requires-approval',
                            reason: 'destructive file operation',
                        },
                    ],
                },
            ),
        );

        expect(signals.map((signal) => signal.type)).toEqual(['started', 'emit', 'failure']);
        expect(signals[1]).toMatchObject({
            type: 'emit',
            event: {
                type: 'policy.blocked',
            },
        });
    });

    it('human approval node emits waiting behavior without interactive input', async () => {
        const registry = createDefaultAbgNodeRegistry();

        const signals = await collectSignals(
            runAbgNode(
                registry,
                {
                    id: 'ask-approval',
                    kind: 'human-approval',
                },
                context,
            ),
        );

        expect(signals.map((signal) => signal.type)).toEqual(['started', 'progress', 'failure']);
        expect(signals[1]).toMatchObject({
            type: 'progress',
            message: 'waiting for human approval: ask-approval',
        });
    });

    it('registry rejects duplicate and unknown implementations', () => {
        const registry = createAbgNodeRegistry();
        const runner = async function* (): AsyncIterable<AbgSignal> {
            yield {
                type: 'started',
                nodeId: 'custom',
            };
        };

        registry.register('custom', runner);

        expect(() => registry.register('custom', runner)).toThrow('ABG node implementation already registered');
        expect(() =>
            runAbgNode(
                registry,
                {
                    id: 'missing',
                    kind: 'action',
                },
                context,
            ),
        ).toThrow('Unknown ABG node implementation');
    });
});
