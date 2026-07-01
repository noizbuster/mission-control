import { type AbgGraphSpec, type AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { ABG_OVERLAY_TABS } from '../components/AbgOverlay.js';
import { createAbgOverlayController } from './abg-overlay-controller.js';
import { createAbgOverlayStore } from './abg-overlay-state.js';
import { wireAbgOverlay } from './interactive-coding-agent.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

describe('overlay integration: controller → AbgOverlay contract (T5 wiring)', () => {
    it('controller.store satisfies the AbgOverlayStore interface AbgOverlay renders against', () => {
        const controller = createAbgOverlayController(createAbgOverlayStore());
        const store = controller.store;
        expect(typeof store.subscribe).toBe('function');
        expect(typeof store.getSnapshot).toBe('function');
        expect(typeof store.update).toBe('function');
    });

    it('controller exposes flushNow and clearTimeline (the ChatApp overlay keymap actions)', () => {
        const controller = createAbgOverlayController(createAbgOverlayStore());
        expect(typeof controller.flushNow).toBe('function');
        expect(typeof controller.clearTimeline).toBe('function');
    });

    it('clearTimeline empties recentEvents (ChatApp "c" keymap action)', () => {
        const store = createAbgOverlayStore();
        const controller = createAbgOverlayController(store);
        store.update((draft) => {
            draft.recentEvents = [
                { type: 'graph.started', timestamp: '2026-01-01T00:00:00Z', message: 'graph started' },
                { type: 'node.started', timestamp: '2026-01-01T00:00:01Z', message: 'node started', nodeId: 'n1' },
            ];
        });
        expect(store.getSnapshot().recentEvents.length).toBeGreaterThan(0);

        controller.clearTimeline();

        expect(store.getSnapshot().recentEvents).toEqual([]);
    });

    it('ABG_OVERLAY_TABS has 8 entries matching the overlay tab strip', () => {
        expect(ABG_OVERLAY_TABS).toHaveLength(8);
        expect(ABG_OVERLAY_TABS[0]).toBe('overview');
        expect(ABG_OVERLAY_TABS[7]).toBe('blackboard');
    });

    it('ChatApp live render path no longer contains the placeholder string', () => {
        const source = readFileSync(resolve(process.cwd(), 'apps/cli/src/components/ChatApp.tsx'), 'utf8');
        expect(source).not.toContain('The ABG monitoring overlay requires an active agent run');
    });
});
