import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    decideSpeculativeWinner,
    readBranchScore,
    runSpeculativeNode,
    type BranchOutcome,
} from './speculative-node.js';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry.js';

const NOW = '2026-06-16T00:00:00.000Z';

describe('decideSpeculativeWinner (pure policy)', () => {
    const outcomes = (scores: readonly number[]): readonly BranchOutcome[] =>
        scores.map((score, index) => ({
            childId: `b${index}`,
            score,
            succeeded: score >= 0,
            result: { score },
        }));

    it('early-stops at the first branch meeting the threshold', () => {
        const d = decideSpeculativeWinner(outcomes([3, 7, 12]), 'score', 10);
        expect(d.earlyStop).toBe(true);
        expect(d.winnerId).toBe('b2');
    });

    it('picks the highest score when no branch trips the threshold (join-rank)', () => {
        const d = decideSpeculativeWinner(outcomes([3, 7, 5]), 'score', 100);
        expect(d.earlyStop).toBe(false);
        expect(d.winnerId).toBe('b1');
    });

    it('rankBy first picks the first succeeded branch', () => {
        const d = decideSpeculativeWinner(outcomes([1, 9, 2]), 'first');
        expect(d.winnerId).toBe('b0');
    });

    it('returns undefined winner when no branch succeeded', () => {
        const failed: readonly BranchOutcome[] = [
            { childId: 'b0', score: 0, succeeded: false, result: undefined },
        ];
        const d = decideSpeculativeWinner(failed, 'score', 10);
        expect(d.winnerId).toBeUndefined();
    });

    it('readBranchScore reads a finite numeric score, else 0', () => {
        expect(readBranchScore({ score: 42 })).toBe(42);
        expect(readBranchScore({})).toBe(0);
        expect(readBranchScore(null)).toBe(0);
        expect(readBranchScore({ score: NaN })).toBe(0);
    });
});

/** A scripted child runner: yields a few `started`-ish signals then a success with a score. */
function scriptedBranch(score: number, delay: number): AbgNodeRunner {
    return async function* (node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
        yield { type: 'started', graphId: context.graphId, nodeId: node.id };
        if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        yield {
            type: 'success',
            graphId: context.graphId,
            nodeId: node.id,
            result: { score, answer: `branch-${node.id}-${score}` },
        };
    };
}

function buildContext(runners: Readonly<Record<string, AbgNodeRunner>>, children: readonly string[]): {
    node: AbgNodeSpec;
    context: AbgNodeRunContext;
} {
    const nodes: Record<string, AbgNodeSpec> = {};
    for (const id of children) {
        nodes[id] = { id, kind: 'action', implementation: id };
    }
    const registry = {
        resolve: (id: string) => runners[id],
    };
    const node: AbgNodeSpec = { id: 'spec', kind: 'parallel', implementation: 'speculative', children: [...children] };
    const context = {
        graphId: 'graph-spec',
        now: () => NOW,
        nodes,
        registry,
    } as AbgNodeRunContext;
    return { node, context };
}

async function run(node: AbgNodeSpec, context: AbgNodeRunContext): Promise<AbgSignal[]> {
    const out: AbgSignal[] = [];
    for await (const signal of runSpeculativeNode(node, context)) {
        out.push(signal);
    }
    return out;
}

/** The speculative NODE's own terminal success (carries winnerId), distinct from child success signals. */
function nodeSuccess(signals: readonly AbgSignal[]): { winnerId?: string; earlyStop?: boolean } | undefined {
    const terminal = signals.find((signal) => signal.type === 'success' && signal.nodeId === 'spec');
    if (terminal?.type !== 'success') {
        return undefined;
    }
    return terminal.result as { winnerId?: string; earlyStop?: boolean };
}

describe('runSpeculativeNode (concurrent drain)', () => {
    it('join-rank: picks the highest-scoring branch when no threshold is set', async () => {
        const { node, context } = buildContext(
            { low: scriptedBranch(2, 0), high: scriptedBranch(9, 0), mid: scriptedBranch(5, 0) },
            ['low', 'high', 'mid'],
        );
        const out = await run(node, context);
        expect(nodeSuccess(out)?.winnerId).toBe('high');
        expect(nodeSuccess(out)?.earlyStop).toBe(false);
    });

    it('early-stop: the first branch crossing the threshold wins and short-circuits', async () => {
        // b0 finishes immediately (score 3, below 10). b1 is slow but scores 15 (≥ 10) → winner.
        const { node, context } = buildContext(
            { b0: scriptedBranch(3, 0), b1: scriptedBranch(15, 15) },
            ['b0', 'b1'],
        );
        node.config = { stopThreshold: 10 };
        const out = await run(node, context);
        expect(nodeSuccess(out)?.winnerId).toBe('b1');
        expect(nodeSuccess(out)?.earlyStop).toBe(true);
    });

    it('rankBy first: the first branch to succeed wins', async () => {
        const { node, context } = buildContext(
            { b0: scriptedBranch(1, 0), b1: scriptedBranch(99, 0) },
            ['b0', 'b1'],
        );
        node.config = { rankBy: 'first' };
        const out = await run(node, context);
        expect(nodeSuccess(out)?.winnerId).toBe('b0');
    });
});
