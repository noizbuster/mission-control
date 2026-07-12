import { describe, expect, it, vi } from 'vitest';
import type { ClipboardService } from './clipboard-service.js';
import type { FocusableSelectionTarget, SelectionCopyRenderer, Toast } from './selection-copy.js';
import { copy } from './selection-copy.js';

function makeToast(): Toast & {
    messages: Array<{ readonly message: string; readonly variant: 'info' | 'success' | 'warning' | 'error' }>;
    errors: unknown[];
} {
    const messages: Array<{ readonly message: string; readonly variant: 'info' | 'success' | 'warning' | 'error' }> =
        [];
    const errors: unknown[] = [];
    return {
        messages,
        errors,
        show(input: { readonly message: string; readonly variant: 'info' | 'success' | 'warning' | 'error' }): void {
            messages.push(input);
        },
        error(err: unknown): void {
            errors.push(err);
        },
    };
}

function makeClipboardService(copied: string[]): ClipboardService {
    return {
        copyToClipboard(text: string): Promise<boolean> {
            copied.push(text);
            return Promise.resolve(true);
        },
        isOsc52Supported(): boolean {
            return true;
        },
    };
}

describe('selection-copy copy()', () => {
    it('copies getSelectedText() and clears the selection when a selection is present', async () => {
        const copied: string[] = [];
        const clipboardService = makeClipboardService(copied);
        const toast = makeToast();
        const clearSelection = vi.fn();
        const target: FocusableSelectionTarget = {};
        const renderer: SelectionCopyRenderer = {
            getSelection() {
                return {
                    getSelectedText: (): string => 'selected text',
                    selectedRenderables: [target],
                };
            },
            clearSelection,
            currentFocusedRenderable: null,
        };

        const result = copy(renderer, toast, clipboardService);

        expect(result).toBe(true);
        expect(copied).toEqual(['selected text']);
        expect(clearSelection).toHaveBeenCalledTimes(1);
        // toast.show fires in the async continuation; flush it.
        await Promise.resolve();
        expect(toast.messages).toEqual([{ message: 'Copied to clipboard', variant: 'info' }]);
    });

    it('applies the focused renderable getClipboardText transform when focus is in selectedRenderables', async () => {
        const copied: string[] = [];
        const clipboardService = makeClipboardService(copied);
        const toast = makeToast();
        const clearSelection = vi.fn();
        const target: FocusableSelectionTarget = {
            getClipboardText: (text: string): string => `transformed:${text}`,
        };
        const renderer: SelectionCopyRenderer = {
            getSelection() {
                return {
                    getSelectedText: (): string => 'raw',
                    selectedRenderables: [target],
                };
            },
            clearSelection,
            currentFocusedRenderable: target,
        };

        const result = copy(renderer, toast, clipboardService);

        expect(result).toBe(true);
        expect(copied).toEqual(['transformed:raw']);
        expect(clearSelection).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(toast.errors).toEqual([]);
    });

    it('returns false and never touches the clipboard when there is no selection', () => {
        const copied: string[] = [];
        const clipboardService = makeClipboardService(copied);
        const toast = makeToast();
        const clearSelection = vi.fn();
        const renderer: SelectionCopyRenderer = {
            getSelection: () => null,
            clearSelection,
        };

        const result = copy(renderer, toast, clipboardService);

        expect(result).toBe(false);
        expect(copied).toEqual([]);
        expect(clearSelection).not.toHaveBeenCalled();
        expect(toast.messages).toEqual([]);
        expect(toast.errors).toEqual([]);
    });

    it('returns false and never touches the clipboard when the selected text is empty', () => {
        const copied: string[] = [];
        const clipboardService = makeClipboardService(copied);
        const toast = makeToast();
        const clearSelection = vi.fn();
        const renderer: SelectionCopyRenderer = {
            getSelection: () => ({ getSelectedText: () => '', selectedRenderables: [] }),
            clearSelection,
        };

        const result = copy(renderer, toast, clipboardService);

        expect(result).toBe(false);
        expect(copied).toEqual([]);
        expect(clearSelection).not.toHaveBeenCalled();
    });

    it('routes clipboard rejection to toast.error and still clears the selection', async () => {
        const toast = makeToast();
        const clearSelection = vi.fn();
        const clipboardService: ClipboardService = {
            copyToClipboard: () => Promise.reject(new Error('osc52 failed')),
            isOsc52Supported: () => true,
        };
        const renderer: SelectionCopyRenderer = {
            getSelection: () => ({ getSelectedText: () => 'text', selectedRenderables: [] }),
            clearSelection,
        };

        const result = copy(renderer, toast, clipboardService);

        expect(result).toBe(true);
        expect(clearSelection).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(toast.errors).toHaveLength(1);
        expect(toast.messages).toEqual([]);
    });
});
