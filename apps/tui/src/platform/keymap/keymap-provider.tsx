/** @jsxImportSource @opentui/solid */
/**
 * Solid context provider that owns the single chat keymap instance (T1) and
 * mounts the pending-sequence cue (T7) and the command palette overlay (T8).
 *
 * Mounted at the top of the ChatRoot subtree so
 * every component below it can read the keymap via `@opentui/keymap/solid`'s
 * `useKeymap` and derive reactive views via `useKeymapSelector`. T1
 * stands up the keymap + bootstrap addons; T7 layers the leader-family addons
 * (inside `createKeymapInstance`) and mounts the pending-sequence cue HERE so
 * it is always available above ChatRoot without touching chat-store state. T9 mounts the which-key panel the
 * same way (self-registers its `Ctrl+Alt+K` toggle + `Ctrl+Alt+Shift+K` layout
 * layer via `registerWhichKeyLayer`) inside a `ModeStackProvider` so the panel
 * (and future overlays under `{children}`) can read/push the active mode.
 *
 * This file is only ever dynamically imported by the opentui TUI path (the TUI
 * path), which keeps `@opentui/keymap/opentui` (and transitively the native
 * `@opentui/core` backend) out of the `--no-tui` module graph.
 */

import type { CliRenderer } from '@opentui/core';
import { KeymapProvider } from '@opentui/keymap/solid';
import { createMemo, createSignal, type JSX } from 'solid-js';
import { createKeymapInstance, type OpenTuiKeymap } from './keymap-instance.js';
import { LeaderPendingCue } from './leader-pending-cue.js';
import { ModeStackProvider } from './mode-stack.js';
import { PaletteOpenContext } from './palette-open-context.js';
import { WhichKeyPanel } from './which-key-panel.js';

export interface ChatKeymapProviderProps {
    /** opentui hook returning the live renderer (same one ChatRoot uses). */
    readonly useRenderer: () => CliRenderer;
    readonly children: JSX.Element;
}

export function ChatKeymapProvider(props: ChatKeymapProviderProps): JSX.Element {
    const renderer = props.useRenderer();
    const keymap = createMemo<OpenTuiKeymap>(() => createKeymapInstance(renderer));
    const [paletteOpen, setPaletteOpen] = createSignal(false);
    return (
        <KeymapProvider keymap={keymap()}>
            <PaletteOpenContext.Provider value={{ open: paletteOpen, setOpen: setPaletteOpen }}>
                <ModeStackProvider>
                    <LeaderPendingCue />
                    <WhichKeyPanel />
                    {props.children}
                </ModeStackProvider>
            </PaletteOpenContext.Provider>
        </KeymapProvider>
    );
}
