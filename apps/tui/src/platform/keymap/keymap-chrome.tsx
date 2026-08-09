/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import { useChatSession } from '../providers/chat-session-context';
import { CommandPaletteOverlay } from './command-palette';
import { LeaderPendingCue } from './leader-pending-cue';
import { WhichKeyPanel } from './which-key-panel';

export function KeymapChrome(): JSX.Element {
    const session = useChatSession();
    return (
        <>
            <LeaderPendingCue />
            <WhichKeyPanel />
            <CommandPaletteOverlay
                onSelectSlash={(slashName) => {
                    const line = slashName.startsWith('/') ? slashName : `/${slashName}`;
                    session.store.sendSlashCommand(line);
                }}
            />
        </>
    );
}
