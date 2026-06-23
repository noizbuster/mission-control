import { type AbgGraphSpec, type AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createAbgOverlayController } from './abg-overlay-controller.js';
import { createAbgOverlayStore } from './abg-overlay-state.js';
import { wireAbgOverlay } from './interactive-coding-agent.js';

function makeStarted(graphId: string, nodeId: string): AbgSignal {
    return { type: 'started', graphId, nodeId };
}
function makeSuccess(graphId: string, nodeId: string): AbgSignal {
    return { type: 'success', graphId, nodeId, result: {} };
}
function makeFailure(graphId: string, nodeId: string, message: string): AbgSignal {
    return { type: 'failure', graphId, nodeId, error: { code: 'test', message } };
}

describe('overlay integration: signal → store', () => {
    it('populates activeGraphId and nodes from started signals', async () => {
        const store = createAbgOverlayStore();
        const controller = createAbgOverlayController(store);
        const wiring = wireAbgOverlay(controller);

        wiring.observer(makeStarted('default', 'intent-gate'));
        wiring.observer(makeSuccess('default', 'intent-gate'));
        wiring.observer(makeStarted('default', 'memory'));
        wiring.dispose();

        const snap = store.getSnapshot();
        expect(snap.activeGraphId).toBe('default');
        expect(snap.nodes.get('intent-gate')).toBe('succeeded');
        expect(snap.nodes.get('memory')).toBe('running');
    });

    it('populates activeGraphId from onDurableEvent graph.started', () => {
        const store = createAbgOverlayStore();
        const controller = createAbgOverlayController(store);
        const wiring = wireAbgOverlay(controller);

        wiring.onDurableEvent({
            type: 'graph.started',
            timestamp: new Date().toISOString(),
            sessionId: 's1',
            message: 'ABG graph started',
            abg: { graphId: 'default' },
        } as any);
        wiring.dispose();

        const snap = store.getSnapshot();
        expect(snap.activeGraphId).toBe('default');
        expect(snap.graphStatus).toBe('active');
        wiring.dispose();
    });

    it('populates nodes from onDurableEvent node.started/completed', () => {
        const store = createAbgOverlayStore();
        const controller = createAbgOverlayController(store);
        const wiring = wireAbgOverlay(controller);

        wiring.onDurableEvent({
            type: 'graph.started',
            timestamp: new Date().toISOString(),
            sessionId: 's1',
            message: 'ABG graph started',
            abg: { graphId: 'default' },
        } as any);
        wiring.onDurableEvent({
            type: 'node.started',
            timestamp: new Date().toISOString(),
            sessionId: 's1',
            message: 'node started: intent-gate',
            abg: { graphId: 'default', nodeId: 'intent-gate', nodeKind: 'llm' },
        } as any);
        wiring.onDurableEvent({
            type: 'node.completed',
            timestamp: new Date().toISOString(),
            sessionId: 's1',
            message: 'node completed: intent-gate',
            abg: { graphId: 'default', nodeId: 'intent-gate', nodeKind: 'llm' },
        } as any);
        wiring.dispose();

        const snap = store.getSnapshot();
        expect(snap.activeGraphId).toBe('default');
        expect(snap.nodes.get('intent-gate')).toBe('succeeded');
        wiring.dispose();
    });

    it('isEmptyState is false after graph.started + node.started', () => {
        const store = createAbgOverlayStore();
        const controller = createAbgOverlayController(store);
        const wiring = wireAbgOverlay(controller);

        wiring.onDurableEvent({
            type: 'graph.started',
            timestamp: new Date().toISOString(),
            sessionId: 's1',
            message: 'ABG graph started',
            abg: { graphId: 'default' },
        } as any);
        wiring.onDurableEvent({
            type: 'node.started',
            timestamp: new Date().toISOString(),
            sessionId: 's1',
            message: 'node started: intent-gate',
            abg: { graphId: 'default', nodeId: 'intent-gate', nodeKind: 'llm' },
        } as any);
        wiring.dispose();

        const snap = store.getSnapshot();
        const empty =
            snap.activeGraphId === undefined ||
            snap.graphStatus === undefined ||
            (snap.nodes.size === 0 && snap.recentEvents.length === 0);
        expect(empty).toBe(false);
        wiring.dispose();
    });
});
