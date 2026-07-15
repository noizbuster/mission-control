/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import { CommandPaletteOverlay } from './command-palette';
import { LeaderPendingCue } from './leader-pending-cue';
import { WhichKeyPanel } from './which-key-panel';

export function KeymapChrome(): JSX.Element {
    return (
        <>
            <LeaderPendingCue />
            <WhichKeyPanel />
            <CommandPaletteOverlay />
        </>
    );
}
