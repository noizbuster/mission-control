import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers';
import { type AbgNodeRunContext, runAbgNode } from './node-registry';

describe('ABG parallel verdict aggregation', () => {
    it('writes all-approve metadata and the aggregated blackboard value', async () => {
        const baseContext = createCompositeNodeTestContext();
        const blackboard = createBlackboard();
        for (const key of ['final.f1', 'final.f2', 'final.f3', 'final.f4']) blackboard.set(key, 'APPROVE');
        const context = {
            ...baseContext,
            blackboard,
            nodes: {
                ...baseContext.nodes,
                f1: { id: 'f1', kind: 'memory' },
                f2: { id: 'f2', kind: 'memory' },
                f3: { id: 'f3', kind: 'memory' },
                f4: { id: 'f4', kind: 'memory' },
            },
        } satisfies AbgNodeRunContext;

        const signals = await collectSignals(
            runAbgNode(
                context.registry,
                {
                    id: 'final-verification-wave',
                    kind: 'parallel',
                    children: ['f1', 'f2', 'f3', 'f4'],
                    config: {
                        aggregateKey: 'final.critics',
                        verdictKey: 'final.verdict',
                        verdictStrategy: 'all-approve',
                        verdictSources: ['final.f1', 'final.f2', 'final.f3', 'final.f4'],
                    },
                },
                context,
            ),
        );

        expect(blackboard.get('final.verdict')).toBe('APPROVE');
        expect(blackboard.get('final.critics')).toEqual(['APPROVE', 'APPROVE', 'APPROVE', 'APPROVE']);
        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: {
                verdict: 'APPROVE',
                verdicts: ['APPROVE', 'APPROVE', 'APPROVE', 'APPROVE'],
                verdictStrategy: 'all-approve',
                verdictSources: ['final.f1', 'final.f2', 'final.f3', 'final.f4'],
            },
        });
        expect(signals).toContainEqual(
            expect.objectContaining({
                type: 'emit',
                event: expect.objectContaining({
                    type: 'blackboard.set',
                    payload: expect.objectContaining({ key: 'final.verdict', value: 'APPROVE' }),
                }),
            }),
        );
    });
});
