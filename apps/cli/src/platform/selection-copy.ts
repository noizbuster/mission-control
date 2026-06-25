import type { ClipboardService } from './clipboard-service.js';

/**
 * A renderable that may carry its own clipboard-text transform.
 *
 * `getClipboardText`, when present, rewrites the selection text for the focused
 * element (e.g. an editor that strips line numbers or joins wrapped lines).
 * Both members are optional so this stays assignable from opentui's
 * `Renderable`, which only declares `hasSelection(): boolean`.
 */
export interface FocusableSelectionTarget {
    hasSelection?: () => boolean;
    getClipboardText?: (text: string) => string;
}

/** Active selection snapshot exposed by the renderer. */
export interface SelectionSnapshot {
    getSelectedText(): string;
    selectedRenderables: FocusableSelectionTarget[];
}

/**
 * Renderer surface the selection-copy helper reads.
 *
 * Structurally compatible with opentui's `CliRenderer` so the concrete handle
 * can be passed straight through (todo 6 wiring) while unit tests inject a
 * plain mock.
 */
export interface SelectionCopyRenderer {
    getSelection(): SelectionSnapshot | null;
    clearSelection(): void;
    currentFocusedRenderable?: FocusableSelectionTarget | null;
}

/** Minimal toast surface the copy helper notifies. */
export interface Toast {
    show(message: string, variant: 'info' | 'success' | 'warning' | 'error'): void;
    error(err: unknown): void;
}

/**
 * Copy the active selection to the clipboard via OSC52.
 *
 * Ported from opencode's `packages/tui/src/util/selection.ts` `copy()` (lines
 * 26-44), preserving the focus -> `getClipboardText` transform and the
 * `selectedRenderables.includes(focus)` guard verbatim. The only substitution
 * is `clipboardService.copyToClipboard(text)` in place of opencode's
 * `clipboard.write`.
 *
 * Fires the clipboard write asynchronously (toast on success, `toast.error` on
 * rejection), clears the renderer's selection, and returns `true`
 * synchronously. Returns `false` when there is no selection or the selected
 * text is empty, without touching the clipboard.
 */
export function copy(renderer: SelectionCopyRenderer, toast: Toast, clipboardService: ClipboardService): boolean {
    const selection = renderer.getSelection();
    if (!selection) return false;

    const text = selection.getSelectedText();
    if (!text) return false;

    const focus = renderer.currentFocusedRenderable;
    const clipboardText =
        focus?.getClipboardText && selection.selectedRenderables.includes(focus)
            ? focus.getClipboardText(text)
            : text;

    clipboardService
        .copyToClipboard(clipboardText)
        .then(() => toast.show('Copied to clipboard', 'info'))
        .catch(toast.error);

    renderer.clearSelection();
    return true;
}
