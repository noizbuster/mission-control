import { errorToString } from '@mission-control/core';
import { useKeyboard } from '@opentui/solid';
import { useContext, type Setter } from 'solid-js';
import { ABG_OVERLAY_TABS } from '../components/AbgOverlay';
import type { ChatTextareaHandle } from '../components/ChatInputTextarea';
import { buildDiffViewerModel, moveLine, nextFile, nextHunk, prevFile, prevHunk } from '../platform/keymap/diff-viewer';
import type { AbgOverlayController } from '../state/abg-overlay-controller';
import { PaletteOpenContext } from '../platform/keymap/palette-open-context';
import type { ChatStore } from '../state/chat-store';

/**
 * Shared deps for the App global keyboard sink (Ctrl+C + overlay-only keys).
 * Frozen for the simplify-tui-mount extract; do not expand casually.
 */
export type GlobalKeyboardDeps = {
    readonly store: ChatStore;
    readonly textareaHandle: ChatTextareaHandle;
    readonly setAbgPanX: Setter<number>;
    readonly abgOverlayController: AbgOverlayController | undefined;
};

const ABG_GRAPH_PAN_STEP = 12;

/**
 * Global keyboard sink: Ctrl+C interrupt/clear, plus ABG/diff overlay keys when
 * the textarea is not focused. Overlay-only guard prevents double-toggle with
 * ChatInputArea onKeyDown (e.g. Ctrl+G).
 */
export function useGlobalKeyboard(deps: GlobalKeyboardDeps): void {
    const { store, textareaHandle, setAbgPanX, abgOverlayController } = deps;
    const paletteOpenState = useContext(PaletteOpenContext);

    // Key-repeat guard for overlay dismiss actions in this sink.
    let dismissSettled = false;
    useKeyboard((key) => {
        const isCtrlC = key.ctrl && key.name === 'c';
        if (isCtrlC) {
            const snap = store.getSnapshot();
            // Decision overlays: Ctrl+C cancels the waiter/decision first.
            if (snap.overlayMode === 'approval') {
                key.preventDefault();
                store.denyApproval();
                return;
            }
            if (snap.overlayMode === 'question') {
                key.preventDefault();
                if (store.rejectQuestion()) {
                    store.sendInterrupt('ctrl-c');
                }
                return;
            }
            if (snap.overlayMode === 'rename') {
                key.preventDefault();
                store.cancelRename();
                return;
            }
            if (
                snap.overlayMode === 'model-picker'
                || snap.overlayMode === 'session-picker'
                || snap.overlayMode === 'level-picker'
            ) {
                key.preventDefault();
                store.cancelPendingOverlayPromises();
                return;
            }
            // Operator/view overlays: dismiss first so Ctrl+C never interrupt/exits underneath.
            if (snap.overlayMode === 'agents-dashboard') {
                key.preventDefault();
                store.hideAgentsDashboard();
                return;
            }
            if (snap.overlayMode === 'mission-panel') {
                key.preventDefault();
                store.hideMissionPanel();
                return;
            }
            if (snap.overlayMode === 'models-overlay') {
                key.preventDefault();
                store.hideModelsOverlay();
                return;
            }
            if (snap.overlayMode === 'diff-viewer') {
                key.preventDefault();
                store.hideDiffViewer();
                return;
            }
            if (snap.overlayMode === 'abg') {
                key.preventDefault();
                if (!dismissSettled) {
                    dismissSettled = true;
                    store.toggleAbgOverlay();
                }
                return;
            }
            if (snap.overlayMode === 'diagnostics') {
                key.preventDefault();
                if (!dismissSettled) {
                    dismissSettled = true;
                    store.hideDiagnosticsOverlay();
                }
                return;
            }
            if (snap.overlayMode === 'tips') {
                key.preventDefault();
                if (!dismissSettled) {
                    dismissSettled = true;
                    store.hideTipsOverlay();
                }
                return;
            }
            if (paletteOpenState?.open() === true) {
                key.preventDefault();
                paletteOpenState.setOpen(false);
                return;
            }
            if (snap.historyPicker.open) {
                key.preventDefault();
                // Esc-parity: dismiss history without destroying the in-progress draft.
                store.cancelHistoryPicker();
                return;
            }
            // While streaming, Ctrl+C stops the agent rather than clearing the draft.
            if (snap.generating) {
                store.sendInterrupt('ctrl-c');
                return;
            }
            const text = textareaHandle.get()?.plainText ?? snap.inputMirror;
            if (text.length > 0) {
                textareaHandle.get()?.clear();
                store.setInputMirror('');
                return;
            }
            store.sendInterrupt('ctrl-c');
            return;
        }
        // When the textarea holds focus, ChatInputArea onKeyDown owns chords like
        // Ctrl+G. Without this guard, opening Ctrl+G would double-toggle.
        if (textareaHandle.get()?.focused) {
            return;
        }
        const snap = store.getSnapshot();
        if (snap.overlayMode === 'none') {
            dismissSettled = false;
        }
        if (key.ctrl && key.name === 'g') {
            key.preventDefault();
            // Only toggle ABG from idle or while already in ABG.
            // Any other overlay owns the mode and must not be stolen.
            if (snap.overlayMode !== 'none' && snap.overlayMode !== 'abg') {
                return;
            }
            try {
                store.toggleAbgOverlay();
            } catch (error: unknown) {
                const message = errorToString(error);
                store.emitOutput(`Error: ABG overlay toggle failed: ${message}\n`);
            }
            return;
        }
        if (snap.overlayMode === 'diagnostics') {
            if (key.name === 'escape') {
                key.preventDefault();
                if (dismissSettled) return;
                dismissSettled = true;
                store.hideDiagnosticsOverlay();
                return;
            }
        }
        if (snap.overlayMode === 'tips') {
            if (key.name === 'escape') {
                key.preventDefault();
                if (dismissSettled) return;
                dismissSettled = true;
                store.hideTipsOverlay();
                return;
            }
        }
        if (snap.overlayMode === 'abg') {
            if (key.name === 'escape') {
                key.preventDefault();
                if (dismissSettled) return;
                dismissSettled = true;
                store.toggleAbgOverlay();
                return;
            }
            if (key.name >= '1' && key.name <= '8') {
                const idx = Number.parseInt(key.name, 10) - 1;
                store.setAbgOverlayActiveTab(idx);
                setAbgPanX(0);
                return;
            }
            if (key.name === 'tab') {
                const next = (store.getSnapshot().abgOverlayActiveTab + 1) % ABG_OVERLAY_TABS.length;
                store.setAbgOverlayActiveTab(next);
                setAbgPanX(0);
                return;
            }
            if (key.name === 'up') {
                store.adjustAbgOverlayScrollOffset(1);
                return;
            }
            if (key.name === 'down') {
                store.adjustAbgOverlayScrollOffset(-1);
                return;
            }
            if (key.name === 'left') {
                setAbgPanX((o) => o + ABG_GRAPH_PAN_STEP);
                return;
            }
            if (key.name === 'right') {
                setAbgPanX((o) => Math.max(0, o - ABG_GRAPH_PAN_STEP));
                return;
            }
            if (key.name === 'r' && abgOverlayController !== undefined) {
                abgOverlayController.flushNow();
                return;
            }
            if (key.name === 'c' && abgOverlayController !== undefined) {
                abgOverlayController.clearTimeline();
                return;
            }
        }
        if (snap.overlayMode === 'diff-viewer') {
            const model = buildDiffViewerModel(snap.diffViewerEntries);
            const cursor = snap.diffViewerCursor;
            if (key.name === 'escape' || key.name === 'q') {
                key.preventDefault();
                if (dismissSettled) return;
                dismissSettled = true;
                store.hideDiffViewer();
                return;
            }
            if (key.name === 'j') {
                key.preventDefault();
                store.setDiffViewerCursor(moveLine(model, cursor, 1));
                return;
            }
            if (key.name === 'k') {
                key.preventDefault();
                store.setDiffViewerCursor(moveLine(model, cursor, -1));
                return;
            }
            if (key.name === ']') {
                key.preventDefault();
                store.setDiffViewerCursor(nextHunk(model, cursor));
                return;
            }
            if (key.name === '[') {
                key.preventDefault();
                store.setDiffViewerCursor(prevHunk(model, cursor));
                return;
            }
            if (key.name === 'n') {
                key.preventDefault();
                store.setDiffViewerCursor(nextFile(model, cursor));
                return;
            }
            if (key.name === 'p') {
                key.preventDefault();
                store.setDiffViewerCursor(prevFile(model, cursor));
                return;
            }
        }
    });
}
