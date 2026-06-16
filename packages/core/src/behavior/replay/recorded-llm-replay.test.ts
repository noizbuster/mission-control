import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { type RecordedTurn, recordedEventTypes, replayRecordedTurn } from './recorded-llm-replay.js';

const NOW = '2026-06-16T00:00:00.000Z';
const ctx = { graphId: 'g1', nodeId: 'llm-1', now: () => NOW };

const recording: RecordedTurn = {
    text: 'Calling echo then finishing.',
    toolCalls: [{ toolCallId: 'call_1', toolName: 'echo', input: { text: 'hi' } }],
    toolResults: [{ toolCallId: 'call_1', toolName: 'echo' }],
    usage: { inputTokens: 4, outputTokens: 6 },
};

async function drain(rec: RecordedTurn): Promise<readonly AbgSignal[]> {
    const out: AbgSignal[] = [];
    for await (const signal of replayRecordedTurn(rec, ctx)) {
        out.push(signal);
    }
    return out;
}

describe('replayRecordedTurn (deterministic replay, ABG §7.5)', () => {
    it('emits the canonical llm.*/tool.* sequence without calling the model', async () => {
        const signals = await drain(recording);
        expect(signals[0]?.type).toBe('started');
        expect(signals.at(-1)?.type).toBe('success');
        expect([...recordedEventTypes(signals)]).toEqual([
            'llm.turn.started',
            'llm.text.delta',
            'llm.tool_call.proposed',
            'tool.completed',
            'llm.turn.completed',
        ]);
    });

    it('is byte-identical across replays of the same recording (determinism)', async () => {
        const first = await drain(recording);
        const second = await drain(recording);
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('omits the text delta for an empty-text turn', async () => {
        const signals = await drain({ ...recording, text: '' });
        expect([...recordedEventTypes(signals)]).not.toContain('llm.text.delta');
    });
});
