/** @jsxImportSource @opentui/react */
/**
 * React context provider that owns the single chat keymap instance (T1) and
 * mounts the pending-sequence cue (T7) and the command palette overlay (T8).
 *
 * Mounted at the top of the ChatRoot subtree (see opentui-chat-bridge.tsx) so
 * every component below it can read the keymap via `@opentui/keymap/react`'s
 * `useKeymap` and derive reactive views via `useKeymapSelectorReact`. T1
 * stands up the keymap + bootstrap addons; T7 layers the leader-family addons
 * (inside `createKeymapInstance`) and mounts the pending-sequence cue HERE so
 * it is always available above ChatRoot without touching the bridge (the plan
 * forbids bridge contention — T5/T6/T10-T15/T16 own the bridge). T8 mounts the
 * Alt+X command palette the same way: it self-registers its toggle + nav
 * keymap layers via `useKeymap` and reads the slash-command mapping table, so
 * it needs no bridge wiring from this lane. T9 mounts the which-key panel the
 * same way (self-registers its `Ctrl+Alt+K` toggle + `Ctrl+Alt+Shift+K` layout
 * layer via `registerWhichKeyLayer`) inside a `ModeStackProvider` so the panel
 * (and future overlays under `{children}`) can read/push the active mode.
 *
 * This file is only ever dynamically imported by the opentui bridge (the TUI
 * path), which keeps `@opentui/keymap/opentui` (and transitively the native
 * `@opentui/core` backend) out of the `--no-tui` module graph.
 */

import type { CliRenderer } from '@opentui/core';
import { KeymapProvider } from '@opentui/keymap/react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { CommandPaletteOverlay } from './command-palette.js';
import { createKeymapInstance, type OpenTuiKeymap } from './keymap-instance.js';
import { LeaderPendingCue } from './leader-pending-cue.js';
import { ModeStackProvider } from './mode-stack.js';
import { PaletteOpenContext } from './palette-open-context.js';
import { WhichKeyPanel } from './which-key-panel.js';

export interface ChatKeymapProviderProps {
    /** opentui hook returning the live renderer (same one ChatRoot uses). */
    readonly useRenderer: () => CliRenderer;
    readonly children: ReactNode;
}

export function ChatKeymapProvider({ useRenderer, children }: ChatKeymapProviderProps): ReactNode {
    const renderer = useRenderer();
    const keymap: OpenTuiKeymap = useMemo(() => createKeymapInstance(renderer), [renderer]);
    const [paletteOpen, setPaletteOpen] = useState(false);
    return (
        <KeymapProvider keymap={keymap}>
            <PaletteOpenContext.Provider value={{ open: paletteOpen, setOpen: setPaletteOpen }}>
                <ModeStackProvider>
                    <LeaderPendingCue />
                    <CommandPaletteOverlay />
                    <WhichKeyPanel />
                    {children}
                </ModeStackProvider>
            </PaletteOpenContext.Provider>
        </KeymapProvider>
    );
}
