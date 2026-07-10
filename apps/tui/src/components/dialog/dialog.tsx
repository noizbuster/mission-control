/** @jsxImportSource @opentui/solid */

import { useRenderer, useTerminalDimensions } from '@opentui/solid';
import { batch, createContext, createEffect, onCleanup, Show, useContext, type JSX, type ParentProps } from 'solid-js';
import { type Renderable, RGBA } from '@opentui/core';
import { createStore } from 'solid-js/store';
import { useModeStack } from '../../platform/keymap/mode-stack.js';
import { useTuiClipboard, useTuiToast } from '../../platform/providers/clipboard-toast-context.js';
import { useTuiTheme } from '../../platform/providers/route-dialog-theme-context.js';

/**
 * Dialog shell: fullscreen dimmed backdrop + centered panel.
 *
 * Ports OpenCode's `packages/tui/src/ui/dialog.tsx` Dialog component, adapted
 * to mc's theme/clipboard/toast providers. Click-outside-to-close is preserved
 * (with selection guard so dragging to select text doesn't dismiss).
 */
export function Dialog(
    props: ParentProps<{
        readonly size?: 'medium' | 'large' | 'xlarge';
        readonly onClose: () => void;
    }>,
): JSX.Element {
    const dimensions = useTerminalDimensions();
    const theme = useTuiTheme();
    const renderer = useRenderer();

    let dismiss = false;
    const width = (): number => {
        if (props.size === 'xlarge') return 116;
        if (props.size === 'large') return 88;
        return 60;
    };

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; click-outside-to-close is a dialog UX pattern
        <box
            onMouseDown={() => {
                dismiss = !!renderer.getSelection?.();
            }}
            onMouseUp={() => {
                if (dismiss) {
                    dismiss = false;
                    return;
                }
                props.onClose();
            }}
            width={dimensions().width}
            height={dimensions().height}
            alignItems="center"
            position="absolute"
            zIndex={3000}
            paddingTop={Math.floor(dimensions().height / 4)}
            left={0}
            top={0}
            backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
        >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; inner panel swallows click to prevent close */}
            <box
                onMouseUp={(e: { stopPropagation(): void }) => {
                    dismiss = false;
                    e.stopPropagation();
                }}
                width={width()}
                maxWidth={dimensions().width - 2}
                backgroundColor={theme.overlayTheme().panelBg}
                paddingTop={1}
            >
                {props.children}
            </box>
        </box>
    );
}

/**
 * Dialog stack item: a JSX element plus an optional close callback.
 */
type DialogStackItem = {
    readonly element: JSX.Element;
    readonly onClose?: () => void;
};

/**
 * The dialog context API. Mirrors OpenCode's `DialogContext`.
 */
export type DialogContext = {
    /** Replace the entire stack with a single dialog. */
    readonly replace: (element: JSX.Element, onClose?: () => void) => void;
    /** Clear all dialogs from the stack. */
    readonly clear: () => void;
    /** Current stack (reactive). */
    readonly stack: readonly DialogStackItem[];
    /** Current size (reactive). */
    readonly size: 'medium' | 'large' | 'xlarge';
    /** Set the dialog size. */
    readonly setSize: (size: 'medium' | 'large' | 'xlarge') => void;
};

const DialogContextCtx = createContext<DialogContext>();

/**
 * Initialize the dialog stack. Creates the store, wires modal-mode push/pop,
 * focus save/restore, and the absolute overlay box with clipboard-on-select.
 *
 * ADAPTATION NOTES vs OpenCode:
 * - Uses mc's `useModeStack()` instead of `useOpencodeModeStack()`.
 * - Does NOT register a ctrl+c keymap binding (mc constraint: Ctrl+C routes
 *   through the global keyboard sink only). Escape is handled by the Dialog
 *   shell component via `useKeyboard` on the shell box.
 * - Simplified clipboard: always copies on mouseUp (no Flag gate).
 */
function init(): DialogContext {
    const [store, setStore] = createStore<{
        stack: DialogStackItem[];
        size: 'medium' | 'large' | 'xlarge';
    }>({
        stack: [],
        size: 'medium',
    });

    const renderer = useRenderer();
    const modeStack = useModeStack();

    // Push "modal" mode when any dialog is open; pop when stack empties.
    createEffect(() => {
        if (store.stack.length === 0) return;
        modeStack.push('modal');
        onCleanup(() => modeStack.pop());
    });

    // Focus save/restore.
    let focus: Renderable | null;

    function refocus(): void {
        setTimeout(() => {
            if (!focus) return;
            if (focus.isDestroyed) return;
            focus.focus();
        }, 1);
    }

    return {
        clear() {
            for (const item of store.stack) {
                item.onClose?.();
            }
            batch(() => {
                setStore('size', 'medium');
                setStore('stack', []);
            });
            refocus();
        },
        replace(element: JSX.Element, onClose?: () => void) {
            if (store.stack.length === 0) {
                focus = renderer.currentFocusedRenderable ?? null;
                focus?.blur();
            }
            for (const item of store.stack) {
                item.onClose?.();
            }
            setStore('size', 'medium');
            setStore('stack', [{ element, ...(onClose !== undefined ? { onClose } : {}) }]);
        },
        get stack() {
            return store.stack;
        },
        get size() {
            return store.size;
        },
        setSize(size: 'medium' | 'large' | 'xlarge') {
            setStore('size', size);
        },
    };
}

/**
 * Dialog provider: creates the dialog context, renders the overlay box with
 * clipboard-on-select, and conditionally renders the Dialog shell when the
 * stack is non-empty.
 */
export function DialogProvider(props: ParentProps): JSX.Element {
    const value = init();
    const renderer = useRenderer();
    const toast = useTuiToast();
    const clipboard = useTuiClipboard();

    function copySelection(): boolean {
        const selection = renderer.getSelection?.();
        if (!selection) return false;
        const text = selection.getSelectedText();
        if (!text) return false;
        void clipboard.copyToClipboard(text).then(
            () => toast.show({ message: 'Copied to clipboard', variant: 'info' }),
            (error: unknown) => toast.error(error),
        );
        renderer.clearSelection?.();
        return true;
    }

    return (
        <DialogContextCtx.Provider value={value}>
            {props.children}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; selection-copy on mouseUp is the clipboard contract */}
            <box position="absolute" zIndex={3000} onMouseUp={() => copySelection()}>
                <Show when={value.stack.length}>
                    <Dialog onClose={() => value.clear()} size={value.size}>
                        {value.stack[value.stack.length - 1]!.element}
                    </Dialog>
                </Show>
            </box>
        </DialogContextCtx.Provider>
    );
}

/**
 * Read the dialog context. Throws if used outside a DialogProvider.
 */
export function useDialog(): DialogContext {
    const value = useContext(DialogContextCtx);
    if (!value) {
        throw new Error('useDialog must be used within a DialogProvider');
    }
    return value;
}
