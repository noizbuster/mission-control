import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createAbgEmitSignal } from './abg-emit.js';
import { projectAbgSignalToEvent } from './signals.js';

const NOW = '2026-06-16T00:00:00.000Z';

function emitSignal(eventType: string, payload?: unknown): AbgSignal {
    return createAbgEmitSignal({
        graphId: 'graph_test',
        nodeId: 'llm_actor',
        source: 'llm-actor',
        eventType,
        timestamp: NOW,
        ...(payload !== undefined ? { payload } : {}),
    });
}

describe('projectAbgSignalToEvent — emit payload preservation', () => {
    it('persists the structured type + payload for a boundary emit (llm.turn.completed)', () => {
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: emitSignal('llm.turn.completed', { text: 'Done.', usage: { total: 6 } }),
            nodeKind: 'llm',
        });

        expect(event.abg?.emit).toEqual({
            type: 'llm.turn.completed',
            payload: { text: 'Done.', usage: { total: 6 } },
        });
    });

    it('persists the type + payload for the other coding-step boundary emits', () => {
        const cases = [
            ['llm.tool_call.proposed', { toolCallId: 'call_1', toolName: 'file.patch', input: {} }],
            ['tool.completed', { toolCallId: 'call_1', toolName: 'file.patch' }],
            ['tool.failed', { toolCallId: 'call_1', toolName: 'file.patch' }],
            ['llm.error', { error: 'boom' }],
        ] as const;

        for (const [type, payload] of cases) {
            const event = projectAbgSignalToEvent({
                graphId: 'graph_test',
                sessionId: 'session_test',
                timestamp: NOW,
                signal: emitSignal(type, payload),
            });
            expect(event.abg?.emit).toEqual({ type, payload });
        }
    });

    it('drops the payload for high-frequency streaming emits (per-token deltas) to keep the ledger lean', () => {
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: emitSignal('llm.text.delta', { delta: 'tok' }),
        });

        // No `abg.emit` at all for non-boundary emits — the ledger stays byte-identical to today.
        expect(event.abg?.emit).toBeUndefined();
    });

    it('carries no emit metadata for non-emit signals', () => {
        const event = projectAbgSignalToEvent({
            graphId: 'graph_test',
            sessionId: 'session_test',
            timestamp: NOW,
            signal: { type: 'started', graphId: 'graph_test', nodeId: 'llm_actor' },
        });

        expect(event.abg?.emit).toBeUndefined();
        expect(event.abg?.signalType).toBe('started');
    });
});
