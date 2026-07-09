/** @jsxImportSource @opentui/solid */

import { TextAttributes } from '@opentui/core';
import type { JSX } from 'solid-js';
import { buildDiffViewerModel, DiffViewerOverlay } from '../platform/keymap/diff-viewer.js';
import type { TerminalViewport } from '../platform/terminal-viewport.js';
import type { AbgOverlayController } from '../state/abg-overlay-controller.js';
import type { ChatStore, ChatStoreState } from '../state/chat-store.js';
import { ABG_OVERLAY_TABS, AbgOverlay, type AbgOverlayTab } from '../components/AbgOverlay.js';
import { ModelsOverlay } from '../components/ModelsOverlay.js';
import { OverlayFrame } from '../components/OverlayFrame.js';
import type { StatusBarProps } from '../components/StatusBar.js';

export type FullscreenOverlaysProps = {
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
 * Shell uses 100% size so it tracks OpenTUI root after processResize.
 */
export function FullscreenOverlays(props: FullscreenOverlaysProps): JSX.Element | null {
    if (props.snap.overlayMode === 'abg') {
        if (props.abgOverlayController === undefined) {
            return (
                <box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows} backgroundColor="#000000">
                    <OverlayFrame variant="view" title="ABG Overlay" hint="(Ctrl+G or Esc to close)">
                        <text attributes={TextAttributes.DIM}>{'ABG overlay unavailable in this session.'}</text>
                    </OverlayFrame>
                </box>
            );
        }

        const selection = props.snap.currentModelSelection;
        const providerID = selection?.providerID ?? props.statusBarProps.providerID;
        const modelID = selection?.modelID ?? props.statusBarProps.modelID;
        const variantID = props.snap.currentModelVariantID;
        const modelLabel = `${providerID}/${modelID}${variantID !== undefined ? `#${variantID}` : ''}`;
        const activeTab: AbgOverlayTab = ABG_OVERLAY_TABS[props.abgActiveTabIndex] ?? 'overview';

        return (
            <box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows} backgroundColor="#000000">
                <AbgOverlay
                    store={props.abgOverlayController.store}
                    activeTab={activeTab}
                    scrollOffset={props.abgScrollOffset}
                    modelLabel={modelLabel}
                    viewport={props.viewport}
                />
            </box>
        );
    }

    if (props.snap.overlayMode === 'diff-viewer') {
        const entries = props.snap.diffViewerEntries;
        const cursor = props.snap.diffViewerCursor;
        const model = buildDiffViewerModel(entries);

        return (
            <box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows} backgroundColor="#000000">
                <DiffViewerOverlay entries={entries} model={model} cursor={cursor} />
            </box>
        );
    }

    if (props.snap.overlayMode === 'models-overlay') {
        return (
            <box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows} backgroundColor="#000000">
                <ModelsOverlay store={props.store} />
            </box>
        );
    }

    return null;
}
