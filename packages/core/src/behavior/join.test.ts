import { describe, expect, it } from 'vitest';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers.js';
import { runAbgNode } from './node-registry.js';

describe('ABG join node', () => {
    it('collects parallel results before joining evidence', async () => {
        const context = createCompositeNodeTestContext();
        const parallelSignals = await collectSignals(
            runAbgNode(
                context.registry,
                { id: 'gather-context', kind: 'parallel', children: ['memory', 'tool'] },
                context,
            ),
        );
        const joinSignals = await collectSignals(
            runAbgNode(
                context.registry,
                {
                    id: 'join-evidence',
                    kind: 'join',
                    config: { items: ['local-memory', 'mock-search', 'local-memory'] },
                },
                context,
            ),
        );

        expect(parallelSignals.filter((signal) => signal.type === 'success')).toHaveLength(3);
        expect(joinSignals.at(-1)).toMatchObject({
            type: 'success',
            result: { items: ['local-memory', 'mock-search'] },
        });
    });

    it('supports append and dedupe merge strategies', async () => {
        const context = createCompositeNodeTestContext();
        const appendSignals = await collectSignals(
            runAbgNode(
                context.registry,
                {
                    id: 'join-append',
                    kind: 'join',
                    config: { mergeStrategy: 'append', items: ['local-memory', 'mock-search', 'local-memory'] },
                },
                context,
            ),
        );
        const dedupeSignals = await collectSignals(
            runAbgNode(
                context.registry,
                {
                    id: 'join-dedupe',
                    kind: 'join',
                    config: { mergeStrategy: 'dedupe', items: ['local-memory', 'mock-search', 'local-memory'] },
                },
                context,
            ),
        );

        expect(appendSignals.at(-1)).toMatchObject({
            type: 'success',
            result: { items: ['local-memory', 'mock-search', 'local-memory'] },
        });
        expect(dedupeSignals.at(-1)).toMatchObject({
            type: 'success',
            result: { items: ['local-memory', 'mock-search'] },
        });
    });
});
