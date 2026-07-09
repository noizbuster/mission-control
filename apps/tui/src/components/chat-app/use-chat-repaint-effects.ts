import { type Accessor, createEffect, onCleanup } from 'solid-js';
import {
    hardResetRendererSurface,
    type RendererSurfaceResetTarget,
} from '../../platform/opentui-renderer.js';
import type { TerminalViewport } from '../../platform/terminal-viewport.js';
import type { ChatStoreOverlayMode } from '../../state/chat-store.js';

export type ChatRepaintRenderer = RendererSurfaceResetTarget & {
    requestRender(): void;
};

export type UseChatRepaintEffectsDeps = {
    readonly renderer: ChatRepaintRenderer;
    readonly viewport: Accessor<TerminalViewport>;
    readonly overlayMode: Accessor<ChatStoreOverlayMode>;
    readonly generating: Accessor<boolean>;
    readonly promptRepaintKey: Accessor<string>;
};

/**
 * Full-repaint / hard-reset effects for OpenTUI double-buffer drift.
 *
 * opentui's double-buffer diff can miss cells when a wide character (Korean
 * Hangul, emoji) is replaced by a narrow one — the continuation cell is not
 * marked dirty, leaving stale pixels that look like garbled text. Force a
 * full repaint (skip the diff, write every cell) when the view changes
 * dramatically: viewport resize, overlay open/close, prompt panel changes,
 * and when a streaming response finishes. During streaming, a 500ms interval
 * corrects accumulated errors without the per-frame cost of always skipping
 * diff.
 */
export function useChatRepaintEffects(deps: UseChatRepaintEffectsDeps): void {
    const { renderer, viewport, overlayMode, generating, promptRepaintKey } = deps;

    let prevViewport = viewport();
    createEffect(() => {
        const currentViewport = viewport();
        if (prevViewport.columns !== currentViewport.columns || prevViewport.rows !== currentViewport.rows) {
            prevViewport = currentViewport;
            hardResetRendererSurface(renderer);
        }
    });

    let prevOverlayMode = overlayMode();
    createEffect(() => {
        if (prevOverlayMode !== overlayMode()) {
            prevOverlayMode = overlayMode();
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
    });

    let prevPromptRepaintKey = promptRepaintKey();
    createEffect(() => {
        if (prevPromptRepaintKey !== promptRepaintKey()) {
            prevPromptRepaintKey = promptRepaintKey();
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
    });

    let prevGenerating = generating();
    createEffect(() => {
        if (prevGenerating && !generating()) {
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
        prevGenerating = generating();
    });

    // During streaming, opentui's cell-diff can miss wide-character continuation
    // cells on every incremental text update. A periodic full repaint corrects
    // the accumulated errors without the per-frame cost of always skipping diff.
    createEffect(() => {
        if (!generating()) return;
        const timer = setInterval(() => {
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }, 500);
        onCleanup(() => clearInterval(timer));
    });
}
