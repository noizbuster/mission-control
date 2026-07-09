/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import type { ChatAppActions } from '../state/chat-app-actions.js';
import type { ChatStore, ChatStoreOverlayMode } from '../state/chat-store.js';
import type { MissionControlServicesLike } from '../state/mission-services-types.js';
import { MissionPanelOverlay } from '../components/MissionPanelOverlay.js';
import {
    AgentsDashboardOverlay,
    ApprovalOverlay,
    LevelPickerOverlay,
    ModelPickerOverlay,
    RenameOverlay,
    SessionPickerOverlay,
} from '../components/OverlayPanels.js';
import { ModalPopup } from './ModalPopup.js';

export type ModalOverlaysProps = {
    readonly store: ChatStore;
    readonly overlayMode: ChatStoreOverlayMode;
    readonly workspaceRoot: string | undefined;
    readonly actions: ChatAppActions | undefined;
    readonly missionControlServices: MissionControlServicesLike | undefined;
};

/**
 * Seven modal popup modes rendered as absolute siblings over the normal layout.
 */
export function ModalOverlays(props: ModalOverlaysProps): JSX.Element {
    return (
        <>
            {props.overlayMode === 'approval' ? (
                <ModalPopup>
                    <ApprovalOverlay store={props.store} />
                </ModalPopup>
            ) : null}
            {props.overlayMode === 'model-picker' ? (
                <ModalPopup>
                    <ModelPickerOverlay store={props.store} />
                </ModalPopup>
            ) : null}
            {props.overlayMode === 'level-picker' ? (
                <ModalPopup>
                    <LevelPickerOverlay store={props.store} />
                </ModalPopup>
            ) : null}
            {props.overlayMode === 'rename' ? (
                <ModalPopup>
                    <RenameOverlay store={props.store} />
                </ModalPopup>
            ) : null}
            {props.overlayMode === 'session-picker' ? (
                <ModalPopup>
                    <SessionPickerOverlay store={props.store} />
                </ModalPopup>
            ) : null}
            {props.overlayMode === 'agents-dashboard' ? (
                <ModalPopup>
                    <AgentsDashboardOverlay
                        store={props.store}
                        workspaceRoot={props.workspaceRoot}
                        {...(props.actions !== undefined ? { actions: props.actions } : {})}
                    />
                </ModalPopup>
            ) : null}
            {props.overlayMode === 'mission-panel' ? (
                <ModalPopup>
                    <MissionPanelOverlay
                        store={props.store}
                        workspaceRoot={props.workspaceRoot}
                        {...(props.actions !== undefined ? { actions: props.actions } : {})}
                        {...(props.missionControlServices !== undefined ? { services: props.missionControlServices } : {})}
                    />
                </ModalPopup>
            ) : null}
        </>
    );
}
