import type { ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { createSignal, type Accessor } from 'solid-js';
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
 *
 * `generation` accessors bump on attach/detach so Solid effects (draft→textarea
 * sync, scroll restore) re-run when the native ref appears after soft remount.
 */
export function useRenderableHandles(): RenderableHandles {
    let textarea: TextareaRenderable | undefined;
    let scrollbox: ScrollBoxRenderable | undefined;
    const [textareaGeneration, setTextareaGeneration] = createSignal(0);
    const [scrollboxGeneration, setScrollboxGeneration] = createSignal(0);

    const textareaHandle: ChatTextareaHandle = {
        get: () => textarea,
        set: (renderable) => {
            textarea = renderable;
            setTextareaGeneration((value) => value + 1);
        },
        clear: () => {
            textarea = undefined;
            setTextareaGeneration((value) => value + 1);
        },
        generation: textareaGeneration as Accessor<number>,
    };

    const scrollboxHandle: ChatScrollboxHandle = {
        get: () => scrollbox,
        set: (renderable) => {
            scrollbox = renderable;
            setScrollboxGeneration((value) => value + 1);
        },
        clear: () => {
            scrollbox = undefined;
            setScrollboxGeneration((value) => value + 1);
        },
        generation: scrollboxGeneration as Accessor<number>,
    };

    const keymapScrollboxRef: ChatKeymapScrollboxRef = {
        get current(): ScrollBoxRenderable | null {
            return scrollbox ?? null;
        },
    };

    return { textareaHandle, scrollboxHandle, keymapScrollboxRef };
}
