/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import type { TerminalViewport } from '../../platform/terminal-viewport.js';
import type { AbgOverlayController } from '../../state/abg-overlay-controller.js';
import type { ChatAppActions } from '../../state/chat-app-actions.js';
import type { ChatStore, ChatStoreState } from '../../state/chat-store.js';
import type { MissionControlServicesLike } from '../../state/mission-services-types.js';
import type { WelcomeData } from '../../state/welcome-data-types.js';
import { ChatBottomDock } from '../ChatBottomDock.js';
import type { ChatTextareaHandle } from '../ChatInputTextarea.js';
import type { ChatScrollboxHandle } from '../ChatTranscript.js';
import type { BottomDockPolicy } from '../chat-bottom-dock-policy.js';
import type { StatusBarProps } from '../StatusBar.js';
import { ChatModalOverlays } from './ChatModalOverlays.js';
import { ChatUpperRegion } from './ChatUpperRegion.js';

export type ChatNormalLayoutProps = {
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
 * Full-screen overlays are handled by {@link ChatFullscreenOverlays} before this mounts.
 */
export function ChatNormalLayout(props: ChatNormalLayoutProps): JSX.Element {
    const bar = props.statusBarProps;
    const upperOutputRegion = (
        <ChatUpperRegion
            showWelcome={props.showWelcome}
            welcomeData={props.welcomeData}
            viewport={props.viewport}
            availableRows={props.dockPolicy.transcript.rows}
            statusBarProps={bar}
            transcript={props.transcript}
            showAgentIndicator={props.showAgentIndicator}
            agentStatusText={props.snap.agentStatusText}
            generating={props.snap.generating}
            showAbgMinimap={props.showAbgMinimap}
            abgOverlayController={props.abgOverlayController}
        />
    );
    const bottomDock = (
        <ChatBottomDock
            store={props.store}
            textareaRef={props.textareaHandle}
            scrollboxRef={props.scrollboxHandle}
            inputFocused={!props.overlayActive}
            viewportColumns={props.viewport.columns}
            viewportRows={props.viewport.rows}
            statusBarProps={bar}
            {...(props.actions !== undefined ? { actions: props.actions } : {})}
        />
    );
    const modalOverlays = (
        <ChatModalOverlays
            store={props.store}
            overlayMode={props.snap.overlayMode}
            workspaceRoot={bar.workspaceRoot}
            actions={props.actions}
            missionControlServices={props.missionControlServices}
        />
    );

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: opentui terminal primitive, not a DOM element; mouse-up only surfaces the copy-hint toast.
        <box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows} shouldFill={true} onMouseUp={props.onMouseUp}>
            <box flexDirection="column" flexGrow={1} shouldFill={true}>
                {upperOutputRegion}
            </box>
            {bottomDock}
            {modalOverlays}
        </box>
    );
}
