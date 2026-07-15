import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore } from '../state/chat-store';
import { asTextareaRef, createRecordingTextarea } from '../components/chat-test-support';
import { useSubmit } from './use-submit';

vi.mock('@mission-control/tui', async () => await import('../terminal-text'));
vi.mock('@mission-control/tui/chat', async () => await import('../chat'));
vi.mock('@mission-control/core', () => ({
    ContinuationRuntime: class ContinuationRuntime {},
    MAIN_AGENT_ID: 'main',
    readBoulder: () => undefined,
    resolveMissionControlDataDir: () => '/tmp/mission-control-test',
    resolveUserConfigDir: () => '/tmp/mission-control-test-config',
}));

function flushSubmitTimers(): void {
    // IME-safe double setTimeout(0): two nested macrotasks.
    vi.runAllTimers();
}

describe('useSubmit', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('calls submitLine with captured text and clears the textarea when no menu insert applies', () => {
        const store = createChatStore();
        const textarea = createRecordingTextarea('hello world');
        const textareaHandle = asTextareaRef(textarea);
        const submitLine = vi.spyOn(store, 'submitLine');
        const handleSubmit = useSubmit({
            store,
            textareaHandle,
            promptMenuInteractionsEnabled: () => true,
        });

        handleSubmit();
        flushSubmitTimers();

        expect(submitLine).toHaveBeenCalledTimes(1);
        expect(submitLine).toHaveBeenCalledWith('hello world');
        expect(textarea.clearCount).toBe(1);
        expect(textarea.plainText).toBe('');
    });

    it('rejects empty / whitespace-only input without calling submitLine', () => {
        const store = createChatStore();
        const textarea = createRecordingTextarea('   ');
        const textareaHandle = asTextareaRef(textarea);
        const submitLine = vi.spyOn(store, 'submitLine');
        const handleSubmit = useSubmit({
            store,
            textareaHandle,
            promptMenuInteractionsEnabled: () => true,
        });

        handleSubmit();
        flushSubmitTimers();

        expect(submitLine).not.toHaveBeenCalled();
        expect(textarea.clearCount).toBe(0);
    });

    it('guards re-entrancy so a second submit before timers fire is ignored', () => {
        const store = createChatStore();
        const textarea = createRecordingTextarea('once');
        const textareaHandle = asTextareaRef(textarea);
        const submitLine = vi.spyOn(store, 'submitLine');
        const handleSubmit = useSubmit({
            store,
            textareaHandle,
            promptMenuInteractionsEnabled: () => true,
        });

        handleSubmit();
        handleSubmit();
        flushSubmitTimers();

        expect(submitLine).toHaveBeenCalledTimes(1);
        expect(submitLine).toHaveBeenCalledWith('once');
    });

    it('inserts slash menu completion instead of submitting when insert text differs', () => {
        const store = createChatStore();
        // Partial `/mo` opens the slash menu on `/model`; insert path expands to
        // a trailing-space token so the next Enter submits the full command.
        const textarea = createRecordingTextarea('/mo');
        const textareaHandle = asTextareaRef(textarea);
        const submitLine = vi.spyOn(store, 'submitLine');
        const setInputMirror = vi.spyOn(store, 'setInputMirror');
        const handleSubmit = useSubmit({
            store,
            textareaHandle,
            promptMenuInteractionsEnabled: () => true,
        });

        handleSubmit();
        flushSubmitTimers();

        expect(submitLine).not.toHaveBeenCalled();
        expect(textarea.setTextCalls.length).toBeGreaterThan(0);
        expect(textarea.gotoBufferEndCount).toBeGreaterThan(0);
        expect(setInputMirror).toHaveBeenCalled();
        const inserted = textarea.setTextCalls[textarea.setTextCalls.length - 1];
        expect(inserted).toBeDefined();
        expect(inserted?.startsWith('/model')).toBe(true);
        expect(inserted?.trimEnd()).not.toBe('/mo');
    });

    it('skips menu insert paths when prompt menu interactions are disabled', () => {
        const store = createChatStore();
        const textarea = createRecordingTextarea('/help');
        const textareaHandle = asTextareaRef(textarea);
        const submitLine = vi.spyOn(store, 'submitLine');
        const handleSubmit = useSubmit({
            store,
            textareaHandle,
            promptMenuInteractionsEnabled: () => false,
        });

        handleSubmit();
        flushSubmitTimers();

        expect(submitLine).toHaveBeenCalledTimes(1);
        expect(submitLine).toHaveBeenCalledWith('/help');
        expect(textarea.clearCount).toBe(1);
    });
});
