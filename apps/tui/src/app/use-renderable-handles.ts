import type { ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import type { ChatTextareaHandle } from '../components/ChatInputTextarea';
import type { ChatScrollboxHandle } from '../components/ChatTranscript';

export type ChatKeymapScrollboxRef = {
    readonly current: ScrollBoxRenderable | null;
};

export type RenderableHandles = {
    readonly textareaHandle: ChatTextareaHandle;
    readonly scrollboxHandle: ChatScrollboxHandle;
    readonly keymapScrollboxRef: ChatKeymapScrollboxRef;
};

/**
 * Owns the App-local textarea and scrollbox renderable handles used by the
 * bottom dock, transcript, and keymap layers. Mount no longer injects external
 * ref callbacks; these stay internal to the chat root.
 */
export function useRenderableHandles(): RenderableHandles {
    let textarea: TextareaRenderable | undefined;
    let scrollbox: ScrollBoxRenderable | undefined;

    const textareaHandle: ChatTextareaHandle = {
        get: () => textarea,
        set: (renderable) => {
            textarea = renderable;
        },
        clear: () => {
            textarea = undefined;
        },
    };

    const scrollboxHandle: ChatScrollboxHandle = {
        get: () => scrollbox,
        set: (renderable) => {
            scrollbox = renderable;
        },
        clear: () => {
            scrollbox = undefined;
        },
    };

    const keymapScrollboxRef: ChatKeymapScrollboxRef = {
        get current(): ScrollBoxRenderable | null {
            return scrollbox ?? null;
        },
    };

    return { textareaHandle, scrollboxHandle, keymapScrollboxRef };
}
