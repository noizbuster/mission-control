/** @jsxImportSource @opentui/solid */

import { TextAttributes } from '@opentui/core';
import type { JSX } from 'solid-js';
import { buildDiffViewerModel, DiffViewerOverlay } from '../../platform/keymap/diff-viewer.js';
import type { TerminalViewport } from '../../platform/terminal-viewport.js';
import type { AbgOverlayController } from '../../state/abg-overlay-controller.js';
import type { ChatStore, ChatStoreState } from '../../state/chat-store.js';
import { ABG_OVERLAY_TABS, AbgOverlay, type AbgOverlayTab } from '../AbgOverlay.js';
import { ModelsOverlay } from '../ModelsOverlay.js';
import { OverlayFrame } from '../OverlayFrame.js';
import type { StatusBarProps } from '../StatusBar.js';

export type ChatFullscreenOverlaysProps = {
    readonly store: ChatStore;
    readonly snap: ChatStoreState;
    readonly viewport: TerminalViewport;
    readonly statusBarProps: StatusBarProps;
    readonly abgOverlayController: AbgOverlayController | undefined;
    readonly abgActiveTabIndex: number;
    readonly abgScrollOffset: number;
};

/**
 * Full-screen overlay modes that replace the normal chat root layout.
 * Returns null when the active overlay is not a full-screen mode.
 */
export function ChatFullscreenOverlays(props: ChatFullscreenOverlaysProps): JSX.Element | null {
    const { store, snap, viewport, statusBarProps, abgOverlayController, abgActiveTabIndex, abgScrollOffset } =
        props;

    if (snap.overlayMode === 'abg') {
        if (abgOverlayController === undefined) {
            return (
                <box flexDirection="column" width={viewport.columns} height={viewport.rows} shouldFill={true}>
                    <OverlayFrame variant="view" title="ABG Overlay" hint="(Ctrl+G or Esc to close)">
                        <text attributes={TextAttributes.DIM}>{'ABG overlay unavailable in this session.'}</text>
                    </OverlayFrame>
                </box>
            );
        }

        const selection = snap.currentModelSelection;
        const providerID = selection?.providerID ?? statusBarProps.providerID;
        const modelID = selection?.modelID ?? statusBarProps.modelID;
        const variantID = snap.currentModelVariantID;
        const modelLabel = `${providerID}/${modelID}${variantID !== undefined ? `#${variantID}` : ''}`;
        const activeTab: AbgOverlayTab = ABG_OVERLAY_TABS[abgActiveTabIndex] ?? 'overview';

        return (
            <box flexDirection="column" width={viewport.columns} height={viewport.rows} shouldFill={true}>
                <AbgOverlay
                    store={abgOverlayController.store}
                    activeTab={activeTab}
                    scrollOffset={abgScrollOffset}
                    modelLabel={modelLabel}
                    viewport={viewport}
                />
            </box>
        );
    }

    if (snap.overlayMode === 'diff-viewer') {
        const entries = snap.diffViewerEntries;
        const cursor = snap.diffViewerCursor;
        const model = buildDiffViewerModel(entries);

        return (
            <box flexDirection="column" width={viewport.columns} height={viewport.rows} shouldFill={true}>
                <DiffViewerOverlay entries={entries} model={model} cursor={cursor} />
            </box>
        );
    }

    if (snap.overlayMode === 'models-overlay') {
        return (
            <box flexDirection="column" width={viewport.columns} height={viewport.rows} shouldFill={true}>
                <ModelsOverlay store={store} />
            </box>
        );
    }

    return null;
}
