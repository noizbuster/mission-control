import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { type Blackboard, createBlackboard } from '../../../memory/blackboard';
import type { AbgNodeRunContext } from '../../node-registry';
import { runLlmActorNode } from './llm-actor-node-runner';

const NOW = '2026-06-20T00:00:00.000Z';

function buildUsage() {
    return {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
}

function modelReturning(text: string): MockLanguageModelV3 {
    const chunks: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
    ];
    return new MockLanguageModelV3({
        provider: 'test',
        modelId: 'mock-fix-loop',
        doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
    });
}

function seedBlackboard(): Blackboard {
    const blackboard = createBlackboard();
    blackboard.appendMessages([{ role: 'user', content: 'fix it' }] as readonly ModelMessage[]);
    return blackboard;
}

const fixLoopNode = {
    id: 'fix-loop',
    kind: 'llm' as const,
    config: {
        outputKey: 'fix.route',
        outputEnum: ['retry', 'blocked'],
        strikeKey: 'fix.strikes',
        strikeBudget: 3,
        maxStrikes: 3,
    },
} as const;

async function visitFixLoop(blackboard: Blackboard, modelText: string): Promise<readonly AbgSignal[]> {
    const context: AbgNodeRunContext = {
        graphId: 'g_strike',
        now: () => NOW,
        sdkModel: modelReturning(modelText),
        blackboard,
    };
    const signals: AbgSignal[] = [];
    for await (const signal of runLlmActorNode(fixLoopNode, context)) {
        signals.push(signal);
    }
    return signals;
}

function strikeRouteOverrides(signals: readonly AbgSignal[]): readonly unknown[] {
    return signals
        .filter((signal): signal is Extract<AbgSignal, { type: 'emit' }> => signal.type === 'emit')
        .filter((signal) => signal.event.type === 'llm.strike_route_overridden')
        .map((signal) => signal.event.payload);
}

describe('runLlmActorNode — hybrid deterministic strike counter', () => {
    it('increments the counter once per visit across visits (absent = 0)', async () => {
        const blackboard = seedBlackboard();
        for (const expectedStrikes of [1, 2, 3]) {
            await visitFixLoop(blackboard, 'retry');
            expect(blackboard.get('fix.strikes')).toBe(expectedStrikes);
        }
    });

    it('honors a prior persisted counter value instead of restarting at zero', async () => {
        const blackboard = seedBlackboard();
        blackboard.set('fix.strikes', 2);
        await visitFixLoop(blackboard, 'blocked');
        expect(blackboard.get('fix.strikes')).toBe(3);
    });

    it("clamps the model's over-optimistic retry to blocked once the budget is reached", async () => {
        const blackboard = seedBlackboard();
        blackboard.set('fix.strikes', 2);

        const signals = await visitFixLoop(blackboard, 'retry');

        // Strike 3 reaches the budget: routeFixLoop(3, 3) === 'blocked' wins.
        expect(blackboard.get('fix.route')).toBe('blocked');
        const overrides = strikeRouteOverrides(signals);
        expect(overrides).toHaveLength(1);
        expect(overrides[0]).toMatchObject({
            key: 'fix.route',
            modelValue: 'retry',
            deterministicRoute: 'blocked',
            strikes: 3,
            budget: 3,
            strikeKey: 'fix.strikes',
        });
    });

    it('lets honest outputs pass through with no override event', async () => {
        const blackboard = seedBlackboard();
        blackboard.set('fix.strikes', 0);

        const firstVisit = await visitFixLoop(blackboard, 'retry');
        expect(blackboard.get('fix.route')).toBe('retry');
        expect(blackboard.get('fix.strikes')).toBe(1);
        expect(strikeRouteOverrides(firstVisit)).toHaveLength(0);

        // Second visit stays under budget: 'retry' remains the deterministic route.
        const secondVisit = await visitFixLoop(blackboard, 'retry');
        expect(blackboard.get('fix.route')).toBe('retry');
        expect(blackboard.get('fix.strikes')).toBe(2);
        expect(strikeRouteOverrides(secondVisit)).toHaveLength(0);
    });

    it('reads maxStrikes as the budget alias when strikeBudget is absent', async () => {
        const blackboard = seedBlackboard();
        blackboard.set('fix.strikes', 0);
        const node = {
            id: 'fix-loop-max',
            kind: 'llm' as const,
            config: {
                outputKey: 'fix.route',
                outputEnum: ['retry', 'blocked'],
                strikeKey: 'fix.strikes',
                maxStrikes: 1,
            },
        } as const;
        const context: AbgNodeRunContext = {
            graphId: 'g_strike_max',
            now: () => NOW,
            sdkModel: modelReturning('retry'),
            blackboard,
        };
        const signals: AbgSignal[] = [];
        for await (const signal of runLlmActorNode(node, context)) {
            signals.push(signal);
        }

        expect(blackboard.get('fix.strikes')).toBe(1);
        expect(blackboard.get('fix.route')).toBe('blocked');
        expect(strikeRouteOverrides(signals)).toHaveLength(1);
    });

    it('nodes without strikeKey behave exactly as before (no counter writes)', async () => {
        const blackboard = seedBlackboard();
        const node = {
            id: 'plain-gate',
            kind: 'llm' as const,
            config: { outputKey: 'fix.route', outputEnum: ['retry', 'blocked'] },
        } as const;
        const context: AbgNodeRunContext = {
            graphId: 'g_strike_absent',
            now: () => NOW,
            sdkModel: modelReturning('retry'),
            blackboard,
        };
        const signals: AbgSignal[] = [];
        for await (const signal of runLlmActorNode(node, context)) {
            signals.push(signal);
        }

        expect(blackboard.has('fix.strikes')).toBe(false);
        expect(blackboard.get('fix.route')).toBe('retry');
        expect(strikeRouteOverrides(signals)).toHaveLength(0);
    });
});
