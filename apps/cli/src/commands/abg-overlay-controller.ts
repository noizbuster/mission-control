import type { AbgOverlayState, AbgOverlayStore } from './abg-overlay-state.js';

/**
 * Controller that binds the {@link AbgOverlayStore} to the Ink chat bridge. Held outside the
 * bridge public surface (todo 3 spec: "injected where createInkChatBridge is called, NOT through
 * the bridge public surface") and stored on the bridge core so handleInput/handleAbgOverlayInput
 * can reach it.
 *
 * Owns the mutable pending-patch buffer and the refresh interval handle. Todo 2's observer wires
 * signal/event patches into the buffer and starts the refresh timer; flushNow force-applies the
 * buffer on demand (the `r` key), reset tears everything down (Metis 5.3 no-leak), and
 * clearTimeline wipes the recent-events pane (the `c` key).
 */
export interface AbgOverlayController {
    readonly store: AbgOverlayStore;
    setActive(value: boolean): void;
    reset(): void;
    flushNow(): void;
    clearTimeline(): void;
}

export function createAbgOverlayController(store: AbgOverlayStore): AbgOverlayController {
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let pendingPatch: Partial<AbgOverlayState> = {};

    return {
        store,
        setActive(value) {
            store.setActive(value);
        },
        reset() {
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
