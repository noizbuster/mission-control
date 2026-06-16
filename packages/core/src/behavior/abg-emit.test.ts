import { describe, expect, it } from 'vitest';
import { createAbgEmitSignal, resetEmitSequence } from './abg-emit.js';

const baseInput = {
    nodeId: 'llm-actor',
    timestamp: '2026-06-16T00:00:00.000Z',
};

describe('createAbgEmitSignal — node-level event ids (review #9)', () => {
    it('produces unique ids for repeated event types within a graph', () => {
        resetEmitSequence('graph-a');
        const ids = [
            createAbgEmitSignal({
                ...baseInput,
                graphId: 'graph-a',
                eventType: 'llm.text.delta',
                payload: { delta: 'a' },
            }),
            createAbgEmitSignal({
                ...baseInput,
                graphId: 'graph-a',
                eventType: 'llm.text.delta',
                payload: { delta: 'b' },
            }),
            createAbgEmitSignal({
                ...baseInput,
                graphId: 'graph-a',
                eventType: 'llm.text.delta',
                payload: { delta: 'c' },
            }),
        ].map((signal) => (signal.type === 'emit' ? signal.event.id : ''));
        expect(new Set(ids).size).toBe(3);
        expect(ids).toEqual([
            'graph-a.llm-actor.llm.text.delta.1',
            'graph-a.llm-actor.llm.text.delta.2',
            'graph-a.llm-actor.llm.text.delta.3',
        ]);
    });

    it('is byte-identical across sequential runs after reset (determinism)', () => {
        const runOnce = (): readonly string[] => {
            resetEmitSequence('graph-determinism');
            const out: string[] = [];
            for (const delta of ['hel', 'lo', ' world']) {
                const signal = createAbgEmitSignal({
                    ...baseInput,
                    graphId: 'graph-determinism',
                    eventType: 'llm.text.delta',
                    payload: { delta },
                });
                if (signal.type === 'emit') {
                    out.push(signal.event.id);
                }
            }
            return out;
        };
        expect(runOnce()).toEqual(runOnce());
    });

    it('isolates counters per graphId (no cross-graph collision)', () => {
        resetEmitSequence('graph-x');
        resetEmitSequence('graph-y');
        const x = createAbgEmitSignal({ ...baseInput, graphId: 'graph-x', eventType: 'llm.text.delta' });
        const y = createAbgEmitSignal({ ...baseInput, graphId: 'graph-y', eventType: 'llm.text.delta' });
        const xId = x.type === 'emit' ? x.event.id : '';
        const yId = y.type === 'emit' ? y.event.id : '';
        // Different graphs start their own sequence at 1 — intentionally distinct strings.
        expect(xId).toBe('graph-x.llm-actor.llm.text.delta.1');
        expect(yId).toBe('graph-y.llm-actor.llm.text.delta.1');
    });

    it('honors an explicit deterministic id (replay path) and does not advance the counter', () => {
        resetEmitSequence('graph-replay');
        const explicit = createAbgEmitSignal({
            ...baseInput,
            graphId: 'graph-replay',
            eventType: 'llm.text.delta',
            id: 'replay.llm-actor.llm.text.delta.0',
        });
        const next = createAbgEmitSignal({ ...baseInput, graphId: 'graph-replay', eventType: 'llm.text.delta' });
        expect(explicit.type === 'emit' && explicit.event.id).toBe('replay.llm-actor.llm.text.delta.0');
        // Explicit id does NOT consume a sequence number, so the counter starts at 1.
        expect(next.type === 'emit' && next.event.id).toBe('graph-replay.llm-actor.llm.text.delta.1');
    });

    it('omits graphId on the signal when none is supplied (uses the graph sentinel for the id)', () => {
        resetEmitSequence(undefined);
        const signal = createAbgEmitSignal({ ...baseInput, graphId: undefined, eventType: 'llm.text.delta' });
        expect(signal.type).toBe('emit');
        if (signal.type === 'emit') {
            expect(signal).not.toHaveProperty('graphId');
            expect(signal.event.id).toBe('graph.llm-actor.llm.text.delta.1');
        }
    });
});
