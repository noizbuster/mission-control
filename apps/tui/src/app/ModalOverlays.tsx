/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import { MissionPanelOverlay } from '../components/MissionPanelOverlay';
import { AgentsDashboardOverlay, ModelPickerOverlay, SessionPickerOverlay } from '../components/OverlayPanels';
import type { ChatAppActions } from '../state/chat-app-actions';
import type { ChatStore, ChatStoreOverlayMode } from '../state/chat-store';
import type { MissionControlServicesLike } from '../state/mission-services-types';
import { ModalPopup } from './ModalPopup';

export type ModalOverlaysProps = {
    readonly store: ChatStore;
    readonly overlayMode: ChatStoreOverlayMode;
    readonly workspaceRoot: string | undefined;
    readonly actions: ChatAppActions | undefined;
    readonly missionControlServices: MissionControlServicesLike | undefined;
};

export function ModalOverlays(props: ModalOverlaysProps): JSX.Element {
    return (
        <>
            {props.overlayMode === 'model-picker' ? (
                <ModalPopup>
                    <ModelPickerOverlay store={props.store} />
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
                        {...(props.missionControlServices !== undefined
                            ? { services: props.missionControlServices }
                            : {})}
                    />
                </ModalPopup>
            ) : null}
        </>
    );
}
