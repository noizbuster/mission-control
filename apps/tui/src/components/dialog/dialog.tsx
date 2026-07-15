/** @jsxImportSource @opentui/solid */

import { useRenderer, useTerminalDimensions } from '@opentui/solid';
import { batch, createContext, createEffect, createSignal, For, onCleanup, Show, useContext, type JSX, type ParentProps } from 'solid-js';
import { TextAttributes, type Renderable } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createStore } from 'solid-js/store';
import {
    APPROVAL_LEVEL_PICKER_ENTRIES,
    APPROVAL_OPTIONS,
    type ChatStore,
} from '../../state/chat-store';
import { useSolidStoreSelector } from '../../platform/use-solid-store-selector';
import { useModeStack } from '../../platform/keymap/mode-stack';
import { useTuiClipboard, useTuiToast } from '../../platform/providers/clipboard-toast-context';
import { useTuiTheme } from '../../platform/providers/route-dialog-theme-context';

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
    const panelWidth = (): number => {
        if (props.size === 'xlarge') return 116;
        if (props.size === 'large') return 88;
        return 60;
    };
    const horizontalPadding = (): number =>
        Math.max(0, Math.floor((dimensions().width - panelWidth()) / 2));

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
            position="absolute"
            zIndex={3000}
            top={1}
            left={horizontalPadding()}
            right={horizontalPadding()}
            backgroundColor={theme.overlayTheme().panelBg}
            borderStyle="single"
            borderColor="#808080"
            paddingTop={1}
        >
            {props.children}
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

    function copySelection(): boolean {
        return false;
    }

    return (
        <DialogContextCtx.Provider value={value}>
            {props.children}
        </DialogContextCtx.Provider>
    );
}

// ---------------------------------------------------------------------------
// DialogOverlay: renders all 5 hosted dialog types inline via <Show>
// conditionals. Each dialog uses useKeyboard for input (no useBindings/textarea)
// to avoid the Solid context loss that occurs when components are created
// inside createEffect or createMemo.
// ---------------------------------------------------------------------------

export function DialogOverlay(props: { readonly store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    const overlayMode = () => snapshot().overlayMode;

    return (
        <>
            <Show when={overlayMode() === 'rename'}>
                <DialogFrame>
                    <RenameDialogBox store={props.store} />
                </DialogFrame>
            </Show>
            <Show when={overlayMode() === 'session-picker'}>
                <DialogFrame>
                    <SessionPickerDialogBox store={props.store} />
                </DialogFrame>
            </Show>
            <Show when={overlayMode() === 'approval'}>
                <DialogFrame>
                    <ApprovalDialogBox store={props.store} />
                </DialogFrame>
            </Show>
            <Show when={overlayMode() === 'level-picker'}>
                <DialogFrame>
                    <LevelPickerDialogBox store={props.store} />
                </DialogFrame>
            </Show>
            <Show when={overlayMode() === 'model-picker'}>
                <DialogFrame>
                    <ModelPickerDialogBox store={props.store} />
                </DialogFrame>
            </Show>
        </>
    );
}

function DialogFrame(props: ParentProps): JSX.Element {
    return (
        <box
            position="absolute"
            top={2}
            left={20}
            right={20}
            backgroundColor="#0a0a0a"
            borderStyle="single"
            borderColor="#808080"
            zIndex={3000}
        >
            {props.children}
        </box>
    );
}

type ListRow = { readonly label: string; readonly description?: string };

function useListNavigation(
    count: () => number,
    onSelect: (index: number) => void,
    onCancel: () => void,
) {
    const [selected, setSelected] = createSignal(0);

    useKeyboard((key) => {
        const len = count();
        if (len === 0) return;
        if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
            key.preventDefault();
            setSelected((prev) => (prev - 1 + len) % len);
            return;
        }
        if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
            key.preventDefault();
            setSelected((prev) => (prev + 1) % len);
            return;
        }
        if (key.name === 'return') {
            key.preventDefault();
            onSelect(selected());
            return;
        }
        if (key.name === 'escape') {
            key.preventDefault();
            onCancel();
            return;
        }
    });

    return selected;
}

function ListView(props: {
    readonly title: string;
    readonly rows: readonly ListRow[];
    readonly selected: () => number;
    readonly footer?: string;
}): JSX.Element {
    return (
        <box paddingLeft={2} paddingRight={2} gap={1}>
            <text attributes={TextAttributes.BOLD} fg="#ffffff">{` ${props.title} `}</text>
            <For each={props.rows}>
                {(row, index) => (
                    <box flexDirection="column">
                        <box flexDirection="row">
                            <text fg={props.selected() === index() ? '#ffff00' : '#666666'}>
                                {props.selected() === index() ? '\u276f ' : '  '}
                            </text>
                            <text fg={props.selected() === index() ? '#ffffff' : '#aaaaaa'}>
                                {row.label}
                            </text>
                        </box>
                        {row.description !== undefined ? (
                            <text fg="#666666">{`    ${row.description}`}</text>
                        ) : null}
                    </box>
                )}
            </For>
            {props.footer !== undefined ? (
                <text fg="#888888">{props.footer}</text>
            ) : null}
        </box>
    );
}

function RenameDialogBox(props: { store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    const [buffer, setBuffer] = createSignal(snapshot().renameBuffer);

    useKeyboard((key) => {
        if (key.name === 'return') {
            key.preventDefault();
            props.store.submitRename(buffer());
            return;
        }
        if (key.name === 'escape') {
            key.preventDefault();
            props.store.cancelRename();
            return;
        }
        if (key.name === 'backspace') {
            key.preventDefault();
            setBuffer((prev) => prev.slice(0, -1));
            return;
        }
        if (key.sequence !== undefined && key.sequence.length === 1 && key.sequence >= ' ' && key.sequence <= '~') {
            key.preventDefault();
            setBuffer((prev) => prev + key.sequence);
        }
    });

    return (
        <box paddingLeft={2} paddingRight={2} gap={1}>
            <text attributes={TextAttributes.BOLD} fg="#ffffff">{' Rename Session '}</text>
            <box flexDirection="row">
                <text fg="#00ffff">{'>'}</text>
                <text fg="#ffffff">{buffer()}</text>
                <text bg="#ffffff" fg="#000000">{'\u2588'}</text>
            </box>
            <text fg="#888888">{'\u23ce'} submit · esc cancel</text>
        </box>
    );
}

function SessionPickerDialogBox(props: { store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    const entries = () => snapshot().sessionPickerEntries;
    const rows = (): ListRow[] =>
        entries().map((e) => ({
            label: e.label.length > 0 ? e.label : e.sessionId,
            ...(e.updatedAt !== undefined ? { description: e.updatedAt } : {}),
        }));

    const selected = useListNavigation(
        () => entries().length,
        (index) => {
            const entry = entries()[index];
            if (entry !== undefined) props.store.hideSessionPicker(entry.sessionId);
        },
        () => props.store.hideSessionPicker(undefined),
    );

    return (
        <ListView
            title="Select Session"
            rows={rows()}
            selected={selected}
            footer="{'\u2191/\u2193'} navigate · {'\u23ce'} select · esc cancel"
        />
    );
}

function ApprovalDialogBox(props: { store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    const rows: ListRow[] = APPROVAL_OPTIONS.map((opt) => ({
        label: opt.label,
        description: opt.description,
    }));

    const selected = useListNavigation(
        () => rows.length,
        (index) => {
            props.store.hideApproval();
            props.store.enqueueEvent({ type: 'line', value: APPROVAL_OPTIONS[index]!.key });
        },
        () => props.store.hideApproval(),
    );

    const toolName = () => snapshot().approvalToolName;
    const action = () => snapshot().approvalAction;

    return (
        <box paddingLeft={2} paddingRight={2} gap={1}>
            <text attributes={TextAttributes.BOLD} fg="#ffffff">{' Approval Required '}</text>
            <text fg="#aaaaaa">{`${toolName()} — ${action()}`}</text>
            <For each={rows}>
                {(row, index) => (
                    <box flexDirection="column">
                        <box flexDirection="row">
                            <text fg={selected() === index() ? '#ffff00' : '#666666'}>
                                {selected() === index() ? '\u276f ' : '  '}
                            </text>
                            <text fg={selected() === index() ? '#ffffff' : '#aaaaaa'}>{row.label}</text>
                        </box>
                        {row.description !== undefined ? (
                            <text fg="#666666">{`    ${row.description}`}</text>
                        ) : null}
                    </box>
                )}
            </For>
            <text fg="#888888">{'\u2191/\u2193'} navigate · {'\u23ce'} select · esc deny</text>
        </box>
    );
}

function LevelPickerDialogBox(props: { store: ChatStore }): JSX.Element {
    const rows: ListRow[] = APPROVAL_LEVEL_PICKER_ENTRIES.map((entry) => ({
        label: entry.label,
        description: entry.desc,
    }));

    const selected = useListNavigation(
        () => rows.length,
        (index) => props.store.hideLevelPicker(APPROVAL_LEVEL_PICKER_ENTRIES[index]!.id),
        () => props.store.hideLevelPicker(undefined),
    );

    return (
        <ListView
            title="Select Approval Level"
            rows={rows}
            selected={selected}
            footer="{'\u2191/\u2193'} navigate · {'\u23ce'} select · esc cancel"
        />
    );
}

function ModelPickerDialogBox(props: { store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    const choices = () => snapshot().modelPickerChoices;
    const rows = (): ListRow[] =>
        choices().map((c) => ({
            label: c.label,
            ...(c.unavailableReason !== undefined ? { description: c.unavailableReason } : {}),
        }));

    const selected = useListNavigation(
        () => choices().length,
        (index) => {
            const choice = choices()[index];
            if (choice !== undefined) props.store.hideModelPicker(choice.selection);
        },
        () => props.store.hideModelPicker(undefined),
    );

    return (
        <ListView
            title="Select Model"
            rows={rows()}
            selected={selected}
            footer="{'\u2191/\u2193'} navigate · {'\u23ce'} select · esc cancel"
        />
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
