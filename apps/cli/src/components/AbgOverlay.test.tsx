import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    type AbgOverlayStore,
    createAbgOverlayStore,
    DEFAULT_REFRESH_MS,
    readRefreshMsFromEnv,
} from '../commands/abg-overlay-state';
import { NARROW_THRESHOLD, shouldCollapseToOverview } from './AbgOverlay';

function createMockStore(): AbgOverlayStore {
    return createAbgOverlayStore();
}

function populateStore(store: AbgOverlayStore): void {
    store.update((draft) => {
        draft.activeGraphId = 'test-graph-123';
        draft.graphStatus = 'active';
        draft.runState = 'running';
        draft.nativeSidecarStatus = 'native';
        draft.inputTokens = 100;
        draft.outputTokens = 200;
        draft.modelCalls = 5;
    });
}

describe('AbgOverlay Store Integration', () => {
    test('store subscription and updates work correctly', () => {
        const store = createMockStore();
        populateStore(store);

        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        const snapshot1 = store.getSnapshot();
        expect(snapshot1.inputTokens).toBe(100);
        expect(snapshot1.outputTokens).toBe(200);
        expect(snapshot1.activeGraphId).toBe('test-graph-123');
        expect(snapshot1.graphStatus).toBe('active');
        expect(snapshot1.runState).toBe('running');

        store.update((draft) => {
            draft.inputTokens = 200;
        });

        expect(listener).toHaveBeenCalledTimes(1);

        const snapshot2 = store.getSnapshot();
        expect(snapshot2.inputTokens).toBe(200);

        unsubscribe();
    });

    test('re-render isolation: overlay store is separate from chat bridge', () => {
        const overlayStore = createMockStore();
        populateStore(overlayStore);

        const chatBridgeStore = createMockStore();

        const overlayListener = vi.fn();
        const chatBridgeListener = vi.fn();

        const overlayUnsubscribe = overlayStore.subscribe(overlayListener);
        const chatBridgeUnsubscribe = chatBridgeStore.subscribe(chatBridgeListener);

        for (let i = 0; i < 30; i++) {
            overlayStore.update((draft) => {
                draft.inputTokens = i;
            });
        }

        expect(overlayListener).toHaveBeenCalledTimes(30);
        expect(chatBridgeListener).not.toHaveBeenCalled();

        overlayUnsubscribe();
        chatBridgeUnsubscribe();
    });

    test('graphId can be set and retrieved', () => {
        const store = createMockStore();

        store.update((draft) => {
            draft.activeGraphId = 'short-id';
        });
        let snapshot = store.getSnapshot();
        expect(snapshot.activeGraphId).toBe('short-id');

        store.update((draft) => {
            draft.activeGraphId = 'very-long-graph-id-that-exceeds-twenty-characters';
        });
        snapshot = store.getSnapshot();
        expect(snapshot.activeGraphId).toBe('very-long-graph-id-that-exceeds-twenty-characters');
        expect(snapshot.activeGraphId?.length).toBeGreaterThan(20);
    });

    test('cost summary defaults to zero when no data', () => {
        const store = createMockStore();

        const snapshot = store.getSnapshot();
        expect(snapshot.costCents).toBeUndefined();
        expect(snapshot.inputTokens).toBe(0);
        expect(snapshot.outputTokens).toBe(0);
        expect(snapshot.modelCalls).toBe(0);
    });

    test('graphStatus can be set to different values', () => {
        const store = createMockStore();

        store.update((draft) => {
            draft.graphStatus = 'active';
        });
        expect(store.getSnapshot().graphStatus).toBe('active');

        store.update((draft) => {
            draft.graphStatus = 'completed';
        });
        expect(store.getSnapshot().graphStatus).toBe('completed');

        store.update((draft) => {
            draft.graphStatus = 'failed';
        });
        expect(store.getSnapshot().graphStatus).toBe('failed');

        store.update((draft) => {
            draft.graphStatus = 'cancelled';
        });
        expect(store.getSnapshot().graphStatus).toBe('cancelled');
    });

    test('runState can be set to different values', () => {
        const store = createMockStore();

        store.update((draft) => {
            draft.runState = 'running';
        });
        expect(store.getSnapshot().runState).toBe('running');

        store.update((draft) => {
            draft.runState = 'completed';
        });
        expect(store.getSnapshot().runState).toBe('completed');

        store.update((draft) => {
            draft.runState = 'failed';
        });
        expect(store.getSnapshot().runState).toBe('failed');

        store.update((draft) => {
            draft.runState = 'blocked_on_approval';
        });
        expect(store.getSnapshot().runState).toBe('blocked_on_approval');

        store.update((draft) => {
            draft.runState = 'idle';
        });
        expect(store.getSnapshot().runState).toBe('idle');
    });

    test('nativeSidecarStatus can be set', () => {
        const store = createMockStore();

        store.update((draft) => {
            draft.nativeSidecarStatus = 'native';
        });
        expect(store.getSnapshot().nativeSidecarStatus).toBe('native');

        store.update((draft) => {
            draft.nativeSidecarStatus = 'mock';
        });
        expect(store.getSnapshot().nativeSidecarStatus).toBe('mock');

        store.update((draft) => {
            draft.nativeSidecarStatus = 'unavailable';
        });
        expect(store.getSnapshot().nativeSidecarStatus).toBe('unavailable');
    });

    test('store reset clears all fields', () => {
        const store = createMockStore();
        populateStore(store);

        expect(store.getSnapshot().activeGraphId).toBe('test-graph-123');
        expect(store.getSnapshot().inputTokens).toBe(100);

        store.reset();

        const snapshot = store.getSnapshot();
        expect(snapshot.activeGraphId).toBeUndefined();
        expect(snapshot.inputTokens).toBe(0);
        expect(snapshot.outputTokens).toBe(0);
        expect(snapshot.graphStatus).toBeUndefined();
        expect(snapshot.runState).toBe('idle');
    });

    test('store isActive and setActive work correctly', () => {
        const store = createMockStore();

        expect(store.isActive()).toBe(false);

        store.setActive(true);
        expect(store.isActive()).toBe(true);

        store.setActive(false);
        expect(store.isActive()).toBe(false);
    });

    test('multiple listeners are notified', () => {
        const store = createMockStore();

        const listener1 = vi.fn();
        const listener2 = vi.fn();
        const listener3 = vi.fn();

        const unsub1 = store.subscribe(listener1);
        const unsub2 = store.subscribe(listener2);
        const unsub3 = store.subscribe(listener3);

        store.update((draft) => {
            draft.inputTokens = 100;
        });

        expect(listener1).toHaveBeenCalledTimes(1);
        expect(listener2).toHaveBeenCalledTimes(1);
        expect(listener3).toHaveBeenCalledTimes(1);

        unsub1();
        store.update((draft) => {
            draft.inputTokens = 200;
        });

        expect(listener1).toHaveBeenCalledTimes(1);
        expect(listener2).toHaveBeenCalledTimes(2);
        expect(listener3).toHaveBeenCalledTimes(2);

        unsub2();
        unsub3();
    });
});

describe('AbgOverlay resize collapse behavior', () => {
    const originalColumns = process.stdout.columns;

    afterEach(() => {
        Object.defineProperty(process.stdout, 'columns', {
            value: originalColumns,
            configurable: true,
            writable: true,
        });
    });

    test('NARROW_THRESHOLD is 100 cols (Metis 2.8 contract)', () => {
        expect(NARROW_THRESHOLD).toBe(100);
    });

    test('wide terminal (200 cols): shouldCollapseToOverview returns false → full 7-tab layout', () => {
        expect(shouldCollapseToOverview(200)).toBe(false);
    });

    test('narrow terminal (80 cols): shouldCollapseToOverview returns true → Overview-only + widen hint', () => {
        expect(shouldCollapseToOverview(80)).toBe(true);
    });

    test('boundary at 100 cols: 100 is wide, 99 collapses', () => {
        expect(shouldCollapseToOverview(100)).toBe(false);
        expect(shouldCollapseToOverview(99)).toBe(true);
    });

    test('resize cycle 200 → 80 → 200 collapses then restores via process.stdout.columns', () => {
        // Given: 200 cols — full overlay
        Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true, writable: true });
        const colsWide = process.stdout.columns ?? 80;
        expect(shouldCollapseToOverview(colsWide)).toBe(false);

        // When: resize to 80 cols — collapse to Overview-only
        Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true, writable: true });
        const colsNarrow = process.stdout.columns ?? 80;
        expect(shouldCollapseToOverview(colsNarrow)).toBe(true);

        // Then: resize back to 200 — restored (decision is pure per-render, no sticky state)
        Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true, writable: true });
        const colsRestored = process.stdout.columns ?? 80;
        expect(shouldCollapseToOverview(colsRestored)).toBe(false);
    });

    test('collapse decision uses the same expression the component reads (process.stdout.columns ?? 80)', () => {
        Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true, writable: true });
        const colsAsReadByComponent = process.stdout.columns ?? 80;
        expect(shouldCollapseToOverview(colsAsReadByComponent)).toBe(true);
        expect(colsAsReadByComponent).toBe(80);
    });

    test('undefined columns (non-TTY) falls back to 80 via component default → collapses', () => {
        Object.defineProperty(process.stdout, 'columns', {
            value: undefined,
            configurable: true,
            writable: true,
        });
        const colsAsReadByComponent = process.stdout.columns ?? 80;
        expect(colsAsReadByComponent).toBe(80);
        expect(shouldCollapseToOverview(colsAsReadByComponent)).toBe(true);
    });
});

describe('readRefreshMsFromEnv tuning (MCTRL_ABG_OVERLAY_REFRESH_MS)', () => {
    const original = process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'];

    afterEach(() => {
        if (original === undefined) {
            delete process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'];
        } else {
            process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'] = original;
        }
    });

    test('DEFAULT_REFRESH_MS contract is 33ms', () => {
        expect(DEFAULT_REFRESH_MS).toBe(33);
    });

    test('MCTRL_ABG_OVERLAY_REFRESH_MS=20 → returns 20 (pass-through, faster than default 33ms)', () => {
        process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'] = '20';
        expect(readRefreshMsFromEnv()).toBe(20);
    });

    test('16ms floor clamp: MCTRL_ABG_OVERLAY_REFRESH_MS=10 → returns 16 (10 is below floor)', () => {
        process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'] = '10';
        expect(readRefreshMsFromEnv()).toBe(16);
    });

    test('16ms floor clamp: MCTRL_ABG_OVERLAY_REFRESH_MS=1 → returns 16 (never thrash Ink)', () => {
        process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'] = '1';
        expect(readRefreshMsFromEnv()).toBe(16);
    });

    test('exactly 16 is the floor boundary (not clamped, passes through)', () => {
        process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'] = '16';
        expect(readRefreshMsFromEnv()).toBe(16);
    });

    test('unset env → returns DEFAULT_REFRESH_MS (33)', () => {
        delete process.env['MCTRL_ABG_OVERLAY_REFRESH_MS'];
        expect(readRefreshMsFromEnv()).toBe(DEFAULT_REFRESH_MS);
        expect(readRefreshMsFromEnv()).toBe(33);
    });
});
