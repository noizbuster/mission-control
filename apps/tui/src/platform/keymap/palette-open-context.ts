/**
 * Shared palette-open state between the command palette (keymap-provider lane)
 * and ChatRoot (bridge lane). FFI-free: imports only `react`'s `createContext`.
 *
 * The palette is mounted inside `ChatKeymapProvider` (a sibling of ChatRoot).
 * When the palette opens, ChatRoot must prevent the focused textarea from
 * processing printable filter keys (double-handle fix T8). This context lets
 * ChatRoot observe the palette's open state without the palette needing access
 * to the bridge core or the textarea ref.
 */

import { createContext } from 'react';

export interface PaletteOpenState {
    readonly open: boolean;
    readonly setOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
}

export const PaletteOpenContext = createContext<PaletteOpenState | null>(null);
