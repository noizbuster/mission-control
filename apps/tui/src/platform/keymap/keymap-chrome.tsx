/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import { CommandPaletteOverlay } from './command-palette.js';
import { LeaderPendingCue } from './leader-pending-cue.js';
import { WhichKeyPanel } from './which-key-panel.js';

export function KeymapChrome(): JSX.Element {
    return (
        <>
            <LeaderPendingCue />
            <WhichKeyPanel />
            <CommandPaletteOverlay />
        </>
    );
}
