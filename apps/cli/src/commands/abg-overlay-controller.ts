import type { AbgOverlayPrefs } from '@mission-control/protocol';
import { saveAbgOverlayPrefs } from './abg-overlay-prefs-store.js';
import type { AbgOverlayState, AbgOverlayStore } from './abg-overlay-state.js';

export type AbgOverlayPrefsSnapshotProvider = () => AbgOverlayPrefs;

export interface AbgOverlayControllerOptions {
    readonly readPrefsSnapshot?: AbgOverlayPrefsSnapshotProvider;
}

export interface AbgOverlayController {
    readonly store: AbgOverlayStore;
    setActive(value: boolean): void;
    reset(): void;
    flushNow(): void;
    clearTimeline(): void;
}

export function createAbgOverlayController(
    store: AbgOverlayStore,
    options: AbgOverlayControllerOptions = {},
): AbgOverlayController {
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let pendingPatch: Partial<AbgOverlayState> = {};
    const readPrefsSnapshot = options.readPrefsSnapshot;

    const persistPrefs = (): void => {
        if (readPrefsSnapshot === undefined) return;
        const snapshot = readPrefsSnapshot();
        void saveAbgOverlayPrefs(snapshot).catch((error) => {
            process.stderr.write(`[abg-overlay] failed to persist preferences: ${String(error)}\n`);
        });
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
            store.setActive(false);
            store.reset();
        },
        flushNow() {
            if (Object.keys(pendingPatch).length === 0) {
                return;
            }
            const patch = pendingPatch;
            pendingPatch = {};
            store.update((draft) => {
                Object.assign(draft, patch);
            });
        },
        clearTimeline() {
            store.update((draft) => {
                draft.recentEvents = [];
            });
        },
    };
}
