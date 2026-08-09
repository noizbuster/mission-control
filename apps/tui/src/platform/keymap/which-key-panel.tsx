/** @jsxImportSource @opentui/solid */
import { padEndToDisplayWidth } from '@mission-control/tui';
import { type KeyEvent, type Renderable, TextAttributes } from '@opentui/core';
import { useBindings, useKeymapSelector } from '@opentui/keymap/solid';
import { createEffect, createMemo, createSignal, For, type JSX, Show, useContext } from 'solid-js';
import { useChatSession } from '../providers/chat-session-context';
import { useSolidStoreSelector } from '../use-solid-store-selector';
import { PaletteOpenContext } from './palette-open-context';
import { useModeStack } from './mode-stack';
import {
    createWhichKeyLayer,
    formatSequence,
    groupEntries,
    nextLayout,
    projectWhichKeyEntries,
    registerWhichKeyLayer,
    selectReachableEntries,
    WHICH_KEY_LAYOUT_COMMAND,
    WHICH_KEY_TOGGLE_COMMAND,
    type WhichKeyGroup,
    type WhichKeyHandlers,
    type WhichKeyLayout,
} from './which-key-panel-core';

export type { WhichKeyGroup, WhichKeyHandlers, WhichKeyLayout };
export {
    formatSequence,
    groupEntries,
    nextLayout,
    projectWhichKeyEntries,
    registerWhichKeyLayer,
    WHICH_KEY_LAYOUT_COMMAND,
    WHICH_KEY_TOGGLE_COMMAND,
};

export function WhichKeyPanel(): JSX.Element {
    const modeStack = useModeStack();
    const entries = useKeymapSelector(selectReachableEntries);
    const chatSession = useChatSession();
    const paletteOpenState = useContext(PaletteOpenContext);
    const overlayMode = useSolidStoreSelector(chatSession.store, (snap) => snap.overlayMode);
    const historyOpen = useSolidStoreSelector(chatSession.store, (snap) => snap.historyPicker.open);
    const [open, setOpen] = createSignal(false);
    const [layout, setLayout] = createSignal<WhichKeyLayout>('dock');

    const blocking = () => overlayMode() !== 'none' || paletteOpenState?.open() === true || historyOpen() === true;
    const handlers: WhichKeyHandlers = {
        onToggle: () => setOpen((value) => !value),
        onLayoutToggle: () => setLayout((value) => nextLayout(value)),
        isEnabled: () => !blocking(),
    };
    useBindings(() => createWhichKeyLayer<Renderable, KeyEvent>(handlers));

    createEffect(() => {
        if (blocking()) setOpen(false);
    });

    const groups = createMemo(() => projectWhichKeyEntries(entries(), modeStack.current()));

    return (
        <Show when={open()}>
            <WhichKeyWindow groups={groups()} layout={layout()} currentMode={modeStack.current()} />
        </Show>
    );
}

function WhichKeyWindow(props: {
    readonly groups: readonly WhichKeyGroup[];
    readonly layout: WhichKeyLayout;
    readonly currentMode: string;
}): JSX.Element {
    const accentFg = '#00ffff';
    const keyFg = '#ffff00';
    const borderColor = '#808080';
    const absolute = (): boolean => props.layout === 'overlay';
    const next = createMemo(() => nextLayout(props.layout));
    const positionAttrs = createMemo(() =>
        absolute() ? { position: 'absolute' as const, top: 1, left: 2, right: 2 } : { left: 0, right: 0 },
    );

    return (
        <box flexDirection="column" {...positionAttrs()} borderStyle="single" borderColor={borderColor}>
            <text attributes={TextAttributes.DIM} fg={accentFg}>
                {`Key bindings (${props.currentMode})  Ctrl+Alt+K close  Ctrl+Alt+Shift+K ${next()}`}
            </text>
            <Show when={props.groups.length === 0}>
                <text attributes={TextAttributes.DIM}>{`  No ${props.currentMode} bindings`}</text>
            </Show>
            <For each={props.groups}>
                {(group) => (
                    <>
                        <text attributes={TextAttributes.DIM} fg={accentFg}>
                            {group.label}
                        </text>
                        <For each={group.entries}>
                            {(entry) => (
                                <box flexDirection="row">
                                    <text attributes={TextAttributes.DIM}>{'  '}</text>
                                    <text attributes={TextAttributes.DIM} fg={keyFg}>
                                        {padEndToDisplayWidth(entry.key, 14)}
                                    </text>
                                    <text attributes={TextAttributes.DIM}>{` ${entry.label}`}</text>
                                </box>
                            )}
                        </For>
                    </>
                )}
            </For>
        </box>
    );
}
