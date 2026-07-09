/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import type { TerminalViewport } from '../platform/terminal-viewport.js';
import type { AbgOverlayController } from '../state/abg-overlay-controller.js';
import type { ChatAppActions } from '../state/chat-app-actions.js';
import type { ChatStore, ChatStoreState } from '../state/chat-store.js';
import type { MissionControlServicesLike } from '../state/mission-services-types.js';
import type { WelcomeData } from '../state/welcome-data-types.js';
import { ChatBottomDock } from '../components/ChatBottomDock.js';
import type { ChatTextareaHandle } from '../components/ChatInputTextarea.js';
import type { ChatScrollboxHandle } from '../components/ChatTranscript.js';
import type { BottomDockPolicy } from '../components/chat-bottom-dock-policy.js';
import type { StatusBarProps } from '../components/StatusBar.js';
import { ModalOverlays } from './ModalOverlays.js';
import { UpperRegion } from './UpperRegion.js';

export type NormalLayoutProps = {
    readonly store: ChatStore;
    readonly snap: ChatStoreState;
    readonly viewport: TerminalViewport;
    readonly statusBarProps: StatusBarProps;
    readonly textareaHandle: ChatTextareaHandle;
    readonly scrollboxHandle: ChatScrollboxHandle;
    readonly overlayActive: boolean;
    readonly actions: ChatAppActions | undefined;
    readonly missionControlServices: MissionControlServicesLike | undefined;
    readonly showWelcome: boolean;
    readonly welcomeData: WelcomeData | undefined;
    readonly dockPolicy: BottomDockPolicy;
    readonly transcript: JSX.Element;
    readonly showAgentIndicator: boolean;
    readonly showAbgMinimap: boolean;
    readonly abgOverlayController: AbgOverlayController | undefined;
};

/** OpenCode body: flexGrow main + flexShrink bottom as siblings of the sized root. */
export function NormalLayout(props: NormalLayoutProps): JSX.Element {
    return (
        <>
            <box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
                <UpperRegion
                    showWelcome={props.showWelcome}
                    welcomeData={props.welcomeData}
                    statusBarProps={props.statusBarProps}
                    transcript={props.transcript}
                    showAgentIndicator={props.showAgentIndicator}
                    agentStatusText={props.snap.agentStatusText}
                    generating={props.snap.generating}
                    showAbgMinimap={props.showAbgMinimap}
                    abgOverlayController={props.abgOverlayController}
                />
            </box>
            <box flexShrink={0} width="100%">
                <ChatBottomDock
                    store={props.store}
                    textareaRef={props.textareaHandle}
                    scrollboxRef={props.scrollboxHandle}
                    inputFocused={!props.overlayActive}
                    statusBarProps={props.statusBarProps}
                    {...(props.actions !== undefined ? { actions: props.actions } : {})}
                />
            </box>
            <ModalOverlays
                store={props.store}
                overlayMode={props.snap.overlayMode}
                workspaceRoot={props.statusBarProps.workspaceRoot}
                actions={props.actions}
                missionControlServices={props.missionControlServices}
            />
        </>
    );
}
