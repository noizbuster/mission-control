import type { AbgSignal } from '@mission-control/protocol';
import { type AbgNodeRegistry, type AbgNodeRunContext, createDefaultAbgNodeRegistry } from './node-registry.js';

export type CompositeNodeTestContext = AbgNodeRunContext & {
    readonly registry: AbgNodeRegistry;
};

export async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

export function createCompositeNodeTestContext(): CompositeNodeTestContext {
    const registry = createDefaultAbgNodeRegistry();
    return {
        graphId: 'graph_composite',
        now: () => '2026-06-03T10:00:00.000Z',
        registry,
        nodes: {
            memory: {
                id: 'memory',
                kind: 'memory',
            },
            tool: {
                id: 'tool',
                kind: 'tool',
            },
            failingCondition: {
                id: 'failingCondition',
                kind: 'condition',
                config: {
                    pass: false,
                },
            },
            passingCondition: {
                id: 'passingCondition',
                kind: 'condition',
            },
        },
    };
}
