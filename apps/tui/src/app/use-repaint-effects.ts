import { type Accessor, createEffect } from 'solid-js';
import type { ChatStoreOverlayMode } from '../state/chat-store.js';

export type ChatRepaintRenderer = {
    requestRender(): void;
};

export type UseRepaintEffectsDeps = {
    readonly renderer: ChatRepaintRenderer;
    readonly overlayMode: Accessor<ChatStoreOverlayMode>;
    readonly generating: Accessor<boolean>;
    readonly promptRepaintKey: Accessor<string>;
};

function requestFullRepaint(renderer: ChatRepaintRenderer): void {
    Reflect.set(renderer, 'forceFullRepaintRequested', true);
    renderer.requestRender();
}

/**
 * Occasional full-repaint for CJK/emoji double-buffer drift.
 * OpenCode has no periodic force-repaint; a 500ms interval while generating
 * races OpenTUI processResize and blanks expanded cells after shrink-then-grow.
 * Only fire on discrete UI transitions (overlay / prompt / stream end).
 */
export function useRepaintEffects(deps: UseRepaintEffectsDeps): void {
    const { renderer, overlayMode, generating, promptRepaintKey } = deps;

    let prevOverlayMode = overlayMode();
    createEffect(() => {
        if (prevOverlayMode !== overlayMode()) {
            prevOverlayMode = overlayMode();
            requestFullRepaint(renderer);
        }
    });

    let prevPromptRepaintKey = promptRepaintKey();
    createEffect(() => {
        if (prevPromptRepaintKey !== promptRepaintKey()) {
            prevPromptRepaintKey = promptRepaintKey();
            requestFullRepaint(renderer);
        }
    });

    let prevGenerating = generating();
    createEffect(() => {
        if (prevGenerating && !generating()) {
            requestFullRepaint(renderer);
        }
        prevGenerating = generating();
    });
}
