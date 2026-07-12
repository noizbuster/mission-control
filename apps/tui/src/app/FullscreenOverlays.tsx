/** @jsxImportSource @opentui/solid */

import { TextAttributes } from '@opentui/core';
import { type JSX, Show } from 'solid-js';
import { ABG_OVERLAY_TABS, AbgOverlay, type AbgOverlayTab } from '../components/AbgOverlay.js';
import { ModelsOverlay } from '../components/ModelsOverlay.js';
import { OverlayFrame } from '../components/OverlayFrame.js';
import type { StatusBarProps } from '../components/StatusBar.js';
import { buildDiffViewerModel, DiffViewerOverlay } from '../platform/keymap/diff-viewer.js';
import type { TerminalViewport } from '../platform/terminal-viewport.js';
import type { AbgOverlayController } from '../state/abg-overlay-controller.js';
import type { ChatStore, ChatStoreState } from '../state/chat-store.js';

export type FullscreenOverlaysProps = {
    readonly store: ChatStore;
    readonly snap: ChatStoreState;
    readonly viewport: TerminalViewport;
    readonly statusBarProps: StatusBarProps;
    readonly abgOverlayController: AbgOverlayController | undefined;
    readonly abgActiveTabIndex: number;
    readonly abgScrollOffset: number;
};

export function FullscreenOverlays(props: FullscreenOverlaysProps): JSX.Element {
    const modelLabel = (): string => {
        const selection = props.snap.currentModelSelection;
        const providerID = selection?.providerID ?? props.statusBarProps.providerID;
        const modelID = selection?.modelID ?? props.statusBarProps.modelID;
        const variantID = props.snap.currentModelVariantID;
        return `${providerID}/${modelID}${variantID !== undefined ? `#${variantID}` : ''}`;
    };
    const activeTab = (): AbgOverlayTab => ABG_OVERLAY_TABS[props.abgActiveTabIndex] ?? 'overview';

    return (
        <>
            <Show when={props.snap.overlayMode === 'abg'}>
                <box flexDirection="column" width="100%" height="100%" backgroundColor="#000000" shouldFill={true}>
                    <Show
                        when={props.abgOverlayController}
                        fallback={
                            <OverlayFrame variant="view" title="ABG Overlay" hint="(Ctrl+G or Esc to close)">
                                <text attributes={TextAttributes.DIM}>
                                    {'ABG overlay unavailable in this session.'}
                                </text>
                            </OverlayFrame>
                        }
                    >
                        {(controller) => (
                            <AbgOverlay
                                store={controller().store}
                                activeTab={activeTab()}
                                scrollOffset={props.abgScrollOffset}
                                modelLabel={modelLabel()}
                                viewport={props.viewport}
                            />
                        )}
                    </Show>
                </box>
            </Show>
            <Show when={props.snap.overlayMode === 'diff-viewer'}>
                <box flexDirection="column" width="100%" height="100%" backgroundColor="#000000" shouldFill={true}>
                    <DiffViewerOverlay
                        entries={props.snap.diffViewerEntries}
                        model={buildDiffViewerModel(props.snap.diffViewerEntries)}
                        cursor={props.snap.diffViewerCursor}
                    />
                </box>
            </Show>
            <Show when={props.snap.overlayMode === 'models-overlay'}>
                <box flexDirection="column" width="100%" height="100%" backgroundColor="#000000" shouldFill={true}>
                    <ModelsOverlay store={props.store} />
                </box>
            </Show>
        </>
    );
}
