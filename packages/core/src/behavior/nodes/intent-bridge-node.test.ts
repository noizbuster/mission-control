/**
 * Unit tests for deterministic intent-bridge runner (Decision 16).
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard';
import { runIntentBridgeNode } from './intent-bridge-node';

const NOW = '2026-07-16T12:00:00.000Z';

const BRIDGE_NODE: AbgNodeSpec = {
    id: 'intent-bridge',
    kind: 'llm',
    implementation: 'intent-bridge',
    capabilities: [],
    config: {},
};

function baseContext(blackboard: ReturnType<typeof createBlackboard>) {
    return {
        graphId: 'planner',
        now: () => NOW,
        blackboard,
    };
}

async function collect(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const out: AbgSignal[] = [];
    for await (const signal of signals) {
        out.push(signal);
    }
    return out;
}

describe('runIntentBridgeNode', () => {
    it('writes intent=clear when ambiguity.classification is clear', async () => {
        // Given
        const blackboard = createBlackboard();
        blackboard.set('ambiguity.classification', 'clear');
        // When
        const signals = await collect(runIntentBridgeNode(BRIDGE_NODE, baseContext(blackboard)));
        // Then
        expect(blackboard.get('intent')).toBe('clear');
        expect(signals.some((signal) => signal.type === 'success')).toBe(true);
    });

    it('writes intent=unclear when ambiguity.classification is unclear', async () => {
        // Given
        const blackboard = createBlackboard();
        blackboard.set('ambiguity.classification', 'unclear');
        // When
        await collect(runIntentBridgeNode(BRIDGE_NODE, baseContext(blackboard)));
        // Then
        expect(blackboard.get('intent')).toBe('unclear');
    });

    it('leaves intent unset when classification is on-the-fence', async () => {
        // Given
        const blackboard = createBlackboard();
        blackboard.set('ambiguity.classification', 'on-the-fence');
        // When
        await collect(runIntentBridgeNode(BRIDGE_NODE, baseContext(blackboard)));
        // Then
        expect(blackboard.get('intent')).toBeUndefined();
    });

    it('fails closed when the blackboard is unavailable', async () => {
        const signals = await collect(
            runIntentBridgeNode(BRIDGE_NODE, {
                graphId: 'planner',
                now: () => NOW,
            }),
        );
        const failure = signals.find((signal) => signal.type === 'failure');
        expect(failure).toMatchObject({ type: 'failure', error: { code: 'memory_unavailable' } });
    });
});
