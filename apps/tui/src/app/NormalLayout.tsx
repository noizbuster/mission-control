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
    readonly onMouseUp: () => void;
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

/**
 * Normal chat root: upper output region, bottom dock, and modal overlays.
 * Full-screen overlays are handled by {@link FullscreenOverlays} before this mounts.
 */
export function NormalLayout(props: NormalLayoutProps): JSX.Element {
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: opentui terminal primitive, not a DOM element; mouse-up only surfaces the copy-hint toast.
        <box
            flexDirection="column"
            width={props.viewport.columns}
            height={props.viewport.rows}
            backgroundColor="#000000"
            onMouseUp={props.onMouseUp}
        >
            <box flexDirection="column" flexGrow={1} minHeight={0}>
                <UpperRegion
                    showWelcome={props.showWelcome}
                    welcomeData={props.welcomeData}
                    viewport={props.viewport}
                    availableRows={props.dockPolicy.transcript.rows}
                    statusBarProps={props.statusBarProps}
                    transcript={props.transcript}
                    showAgentIndicator={props.showAgentIndicator}
                    agentStatusText={props.snap.agentStatusText}
                    generating={props.snap.generating}
                    showAbgMinimap={props.showAbgMinimap}
                    abgOverlayController={props.abgOverlayController}
                />
            </box>
            <box flexShrink={0}>
                <ChatBottomDock
                    store={props.store}
                    textareaRef={props.textareaHandle}
                    scrollboxRef={props.scrollboxHandle}
                    inputFocused={!props.overlayActive}
                    viewportColumns={props.viewport.columns}
                    viewportRows={props.viewport.rows}
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
        </box>
    );
}
