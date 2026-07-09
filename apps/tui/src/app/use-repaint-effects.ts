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

/**
 * OpenCode does not force-full-repaint on UI transitions. Full repaint races
 * OpenTUI processResize and blanks expanded cells after shrink-then-grow.
 * Only schedule a normal requestRender on discrete UI changes.
 */
export function useRepaintEffects(deps: UseRepaintEffectsDeps): void {
    const { renderer, overlayMode, generating, promptRepaintKey } = deps;

    let prevOverlayMode = overlayMode();
    createEffect(() => {
        if (prevOverlayMode !== overlayMode()) {
            prevOverlayMode = overlayMode();
            renderer.requestRender();
        }
    });

    let prevPromptRepaintKey = promptRepaintKey();
    createEffect(() => {
        if (prevPromptRepaintKey !== promptRepaintKey()) {
            prevPromptRepaintKey = promptRepaintKey();
            renderer.requestRender();
        }
    });

    let prevGenerating = generating();
    createEffect(() => {
        if (prevGenerating && !generating()) {
            renderer.requestRender();
        }
        prevGenerating = generating();
    });
}
