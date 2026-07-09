/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import type { ChatAppActions } from '../../state/chat-app-actions.js';
import type { ChatStore, ChatStoreOverlayMode } from '../../state/chat-store.js';
import type { MissionControlServicesLike } from '../../state/mission-services-types.js';
import { MissionPanelOverlay } from '../MissionPanelOverlay.js';
import {
    AgentsDashboardOverlay,
    ApprovalOverlay,
    LevelPickerOverlay,
    ModelPickerOverlay,
    RenameOverlay,
    SessionPickerOverlay,
} from '../OverlayPanels.js';
import { ModalPopup } from './ModalPopup.js';

export type ChatModalOverlaysProps = {
    readonly store: ChatStore;
    readonly overlayMode: ChatStoreOverlayMode;
    readonly workspaceRoot: string | undefined;
    readonly actions: ChatAppActions | undefined;
    readonly missionControlServices: MissionControlServicesLike | undefined;
};

/**
 * Seven modal popup modes rendered as absolute siblings over the normal layout.
 */
export function ChatModalOverlays(props: ChatModalOverlaysProps): JSX.Element {
    const { store, overlayMode, workspaceRoot, actions, missionControlServices } = props;

    return (
        <>
            {overlayMode === 'approval' ? (
                <ModalPopup>
                    <ApprovalOverlay store={store} />
                </ModalPopup>
            ) : null}
            {overlayMode === 'model-picker' ? (
                <ModalPopup>
                    <ModelPickerOverlay store={store} />
                </ModalPopup>
            ) : null}
            {overlayMode === 'level-picker' ? (
                <ModalPopup>
                    <LevelPickerOverlay store={store} />
                </ModalPopup>
            ) : null}
            {overlayMode === 'rename' ? (
                <ModalPopup>
                    <RenameOverlay store={store} />
                </ModalPopup>
            ) : null}
            {overlayMode === 'session-picker' ? (
                <ModalPopup>
                    <SessionPickerOverlay store={store} />
                </ModalPopup>
            ) : null}
            {overlayMode === 'agents-dashboard' ? (
                <ModalPopup>
                    <AgentsDashboardOverlay
                        store={store}
                        workspaceRoot={workspaceRoot}
                        {...(actions !== undefined ? { actions } : {})}
                    />
                </ModalPopup>
            ) : null}
            {overlayMode === 'mission-panel' ? (
                <ModalPopup>
                    <MissionPanelOverlay
                        store={store}
                        workspaceRoot={workspaceRoot}
                        {...(actions !== undefined ? { actions } : {})}
                        {...(missionControlServices !== undefined ? { services: missionControlServices } : {})}
                    />
                </ModalPopup>
            ) : null}
        </>
    );
}
