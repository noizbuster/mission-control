import type { AbgOverlayPrefs } from '@mission-control/protocol';
import { saveAbgOverlayPrefs } from './abg-overlay-prefs-store';
import type { AbgOverlayState, AbgOverlayStore } from './abg-overlay-state';

export type AbgOverlayPrefsSnapshotProvider = () => AbgOverlayPrefs;

export interface AbgOverlayControllerOptions {
    readonly readPrefsSnapshot?: AbgOverlayPrefsSnapshotProvider;
}

export interface AbgOverlayController {
    readonly store: AbgOverlayStore;
    setActive(value: boolean): void;
    reset(): void;
    /**
     * Register the live overlay batch flusher (from wireAbgOverlay).
     * Keyboard `r` and explicit flush call this so pending graph patches commit immediately.
     */
    bindFlush(handler: (() => void) | undefined): void;
    flushNow(): void;
    clearTimeline(): void;
}

export function createAbgOverlayController(
    store: AbgOverlayStore,
    options: AbgOverlayControllerOptions = {},
): AbgOverlayController {
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let pendingPatch: Partial<AbgOverlayState> = {};
    let flushHandler: (() => void) | undefined;
    const readPrefsSnapshot = options.readPrefsSnapshot;
    // Serialize prefs flushes so rapid reset/teardown cannot last-write-win on disk.
    let persistChain: Promise<void> = Promise.resolve();

    const persistPrefs = (): void => {
        if (readPrefsSnapshot === undefined) return;
        const snapshot = readPrefsSnapshot();
        const run = persistChain.then(
            () => saveAbgOverlayPrefs(snapshot),
            () => saveAbgOverlayPrefs(snapshot),
        );
        persistChain = run.then(
            () => undefined,
            () => undefined,
        );
        void run.catch(() => {});
    };

    return {
        store,
        setActive(value) {
            store.setActive(value);
        },
        reset() {
            persistPrefs();
            if (refreshTimer !== undefined) {
                clearInterval(refreshTimer);
                refreshTimer = undefined;
            }
            pendingPatch = {};
            flushHandler = undefined;
            store.setActive(false);
            store.reset();
        },
        bindFlush(handler) {
            flushHandler = handler;
        },
        flushNow() {
            if (Object.keys(pendingPatch).length > 0) {
                const patch = pendingPatch;
                pendingPatch = {};
                store.update((draft) => {
                    Object.assign(draft, patch);
                });
            }
            flushHandler?.();
        },
        clearTimeline() {
            store.update((draft) => {
                draft.recentEvents = [];
            });
        },
    };
}
