/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import type { ChatAppActions } from '../state/chat-app-actions';
import type { ChatStore, ChatStoreOverlayMode } from '../state/chat-store';
import type { MissionControlServicesLike } from '../state/mission-services-types';
import { MissionPanelOverlay } from '../components/MissionPanelOverlay';
import { AgentsDashboardOverlay } from '../components/OverlayPanels';
import { ModalPopup } from './ModalPopup';

export type ModalOverlaysProps = {
    readonly store: ChatStore;
    readonly overlayMode: ChatStoreOverlayMode;
    readonly workspaceRoot: string | undefined;
    readonly actions: ChatAppActions | undefined;
    readonly missionControlServices: MissionControlServicesLike | undefined;
};

/**
 * Modal popup modes rendered as absolute siblings over the normal layout.
 * The rename, approval, level-picker, model-picker, and session-picker
 * overlays have been migrated to the OpenCode-style dialog stack
 * (see `components/dialog/`). This component renders only the remaining
 * complex modal overlays that still use the ModalPopup shell.
 */
export function ModalOverlays(props: ModalOverlaysProps): JSX.Element {
    return (
        <>
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
