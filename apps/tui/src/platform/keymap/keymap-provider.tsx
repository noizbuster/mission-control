/** @jsxImportSource @opentui/solid */

import type { CliRenderer } from '@opentui/core';
import { KeymapProvider } from '@opentui/keymap/solid';
import { createMemo, createSignal, type JSX } from 'solid-js';
import { createKeymapInstance, type OpenTuiKeymap } from './keymap-instance';
import { ModeStackProvider } from './mode-stack';
import { PaletteOpenContext } from './palette-open-context';

export interface ChatKeymapProviderProps {
    readonly useRenderer: () => CliRenderer;
    readonly children: JSX.Element;
}

export function ChatKeymapProvider(props: ChatKeymapProviderProps): JSX.Element {
    const renderer = props.useRenderer();
    const keymap = createMemo<OpenTuiKeymap>(() => createKeymapInstance(renderer));
    const [paletteOpen, setPaletteOpen] = createSignal(false);
    const [paletteCanOpen, setPaletteCanOpen] = createSignal(true);
    return (
        <KeymapProvider keymap={keymap()}>
            <PaletteOpenContext.Provider
                value={{
                    open: paletteOpen,
                    setOpen: setPaletteOpen,
                    canOpen: paletteCanOpen,
                    setCanOpen: setPaletteCanOpen,
                }}
            >
                <ModeStackProvider>{props.children}</ModeStackProvider>
            </PaletteOpenContext.Provider>
        </KeymapProvider>
    );
}
