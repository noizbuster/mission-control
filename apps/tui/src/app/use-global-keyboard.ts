import { useKeyboard } from '@opentui/solid';
import type { Setter } from 'solid-js';
import { ABG_OVERLAY_TABS } from '../components/AbgOverlay.js';
import type { ChatTextareaHandle } from '../components/ChatInputTextarea.js';
import {
    buildDiffViewerModel,
    moveLine,
    nextFile,
    nextHunk,
    prevFile,
    prevHunk,
} from '../platform/keymap/diff-viewer.js';
import type { AbgOverlayController } from '../state/abg-overlay-controller.js';
import type { ChatStore } from '../state/chat-store.js';

/**
 * Shared deps for the App global keyboard sink (Ctrl+C + overlay-only keys).
 * Frozen for the simplify-tui-mount extract; do not expand casually.
 */
export type GlobalKeyboardDeps = {
    readonly store: ChatStore;
    readonly textareaHandle: ChatTextareaHandle;
    readonly setAbgActiveTab: Setter<number>;
    readonly setAbgScrollOffset: Setter<number>;
    readonly abgOverlayController: AbgOverlayController | undefined;
};

/**
 * Global keyboard sink: Ctrl+C interrupt/clear, plus ABG/diff overlay keys when
 * the textarea is not focused. Overlay-only guard prevents double-toggle with
 * ChatInputArea onKeyDown (e.g. Ctrl+G).
 */
export function useGlobalKeyboard(deps: GlobalKeyboardDeps): void {
    const { store, textareaHandle, setAbgActiveTab, setAbgScrollOffset, abgOverlayController } = deps;

    useKeyboard((key) => {
        const isCtrlC = key.ctrl && key.name === 'c';
        if (isCtrlC) {
            const snap = store.getSnapshot();
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
        // Global sink is overlay-only: when the textarea holds focus, its onKeyDown
        // (in ChatInputArea) owns chords like Ctrl+G. Without this guard, the opening
        // Ctrl+G would double-toggle: textarea opens the overlay, then this sink reads
        // the updated snapshot and immediately closes it.
        if (textareaHandle.get()?.focused) {
            return;
        }
        const snap = store.getSnapshot();
        if (snap.overlayMode === 'abg') {
            if (key.name === 'escape' || (key.ctrl && key.name === 'g')) {
                key.preventDefault();
                store.toggleAbgOverlay();
                return;
            }
            if (key.name >= '1' && key.name <= '8') {
                const idx = Number.parseInt(key.name, 10) - 1;
                setAbgActiveTab(idx);
                setAbgScrollOffset(0);
                return;
            }
            if (key.name === 'tab') {
                setAbgActiveTab((i) => (i + 1) % ABG_OVERLAY_TABS.length);
                setAbgScrollOffset(0);
                return;
            }
            if (key.name === 'up') {
                setAbgScrollOffset((o) => o + 1);
                return;
            }
            if (key.name === 'down') {
                setAbgScrollOffset((o) => Math.max(0, o - 1));
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
