/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import type { TerminalViewport } from '../platform/terminal-viewport';
import type { AbgOverlayController } from '../state/abg-overlay-controller';
import type { ChatAppActions } from '../state/chat-app-actions';
import type { ChatStore, ChatStoreState } from '../state/chat-store';
import type { MissionControlServicesLike } from '../state/mission-services-types';
import type { WelcomeData } from '../state/welcome-data-types';
import { ChatBottomDock } from '../components/ChatBottomDock';
import type { ChatTextareaHandle } from '../components/ChatInputTextarea';
import type { ChatScrollboxHandle } from '../components/ChatTranscript';
import type { BottomDockPolicy } from '../components/chat-bottom-dock-policy';
import type { StatusBarProps } from '../components/StatusBar';
import { ModalOverlays } from './ModalOverlays';
import { UpperRegion } from './UpperRegion';

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
