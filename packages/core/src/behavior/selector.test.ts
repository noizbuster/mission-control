import { describe, expect, it } from 'vitest';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers.js';
import { runAbgNode } from './node-registry.js';

describe('ABG selector node', () => {
    it('returns a successful none selection when no child matches', async () => {
        const context = createCompositeNodeTestContext();

        const signals = await collectSignals(
            runAbgNode(
                context.registry,
                { id: 'select-none', kind: 'selector', children: ['failingCondition'] },
                context,
            ),
        );

        expect(signals.at(-1)).toMatchObject({ type: 'success', result: { selection: 'none' } });
        expect(signals.some((signal) => signal.type === 'failure')).toBe(false);
    });

    it('follows configured child priority', async () => {
        const context = createCompositeNodeTestContext();

        const signals = await collectSignals(
            runAbgNode(
                context.registry,
                {
                    id: 'select-priority',
                    kind: 'selector',
                    children: ['memory', 'tool'],
                    config: { priorities: ['tool', 'memory'] },
                },
                context,
            ),
        );

        expect(signals[1]).toMatchObject({ type: 'started', nodeId: 'tool' });
        expect(signals.at(-1)).toMatchObject({ type: 'success', result: { selectedChild: 'tool' } });
    });
});
