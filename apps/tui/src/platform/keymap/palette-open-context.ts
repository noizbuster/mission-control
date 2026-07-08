/**
 * Shared palette-open state between the command palette (keymap-provider lane)
 * and ChatRoot (bridge lane). FFI-free: imports only Solid context types.
 *
 * The palette is mounted inside `ChatKeymapProvider` (a sibling of ChatRoot).
 * When the palette opens, ChatRoot must prevent the focused textarea from
 * processing printable filter keys (double-handle fix T8). This context lets
 * ChatRoot observe the palette's open state without the palette needing access
 * to the bridge core or the textarea ref.
 */

import { type Accessor, createContext, type Setter } from 'solid-js';

export interface PaletteOpenState {
    readonly open: Accessor<boolean>;
    readonly setOpen: Setter<boolean>;
}

export const PaletteOpenContext = createContext<PaletteOpenState>();
