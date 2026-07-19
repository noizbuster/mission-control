import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatTuiHandle } from '../create-chat-tui';
import { createChatStore } from './chat-store';

type TranscriptFallbackEmitter = {
    readonly emitTranscriptFallback: (text: string) => void;
};

function hasTranscriptFallbackEmitter(value: object): value is TranscriptFallbackEmitter {
    return 'emitTranscriptFallback' in value && typeof value.emitTranscriptFallback === 'function';
}

describe('transcript fallback-only output seam', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('appends byte-exact store output without creating or merging a legacy row', () => {
        // Given
        vi.useFakeTimers();
        const store = createChatStore();
        store.emitTranscriptPart(
            { id: 'assistant-fallback', type: 'assistant', text: 'semantic response', status: 'completed' },
            'Assistant: semantic response\n',
        );
        const emitter: object = store;

        // When
        expect(hasTranscriptFallbackEmitter(emitter), 'ChatStore must expose emitTranscriptFallback(text).').toBe(true);
        if (!hasTranscriptFallbackEmitter(emitter)) return;
        emitter.emitTranscriptFallback('fallback\r\nbytes\n');
        vi.runAllTimers();

        // Then
        expect(store.getOutput()).toBe('Assistant: semantic response\nfallback\r\nbytes\n');
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'assistant-fallback', type: 'assistant', text: 'semantic response', status: 'completed' },
        ]);
    });

    it('forwards fallback-only bytes through the TUI handle exactly once', () => {
        // Given
        vi.useFakeTimers();
        const store = createChatStore();
        store.emitTranscriptPart(
            { id: 'assistant-handle', type: 'assistant', text: 'semantic response', status: 'completed' },
            '',
        );
        const handle: object = createChatTuiHandle(store, () => {});

        // When
        expect(hasTranscriptFallbackEmitter(handle), 'ChatTuiHandle must expose emitTranscriptFallback(text).').toBe(
            true,
        );
        if (!hasTranscriptFallbackEmitter(handle)) return;
        handle.emitTranscriptFallback('one fallback\n');
        vi.runAllTimers();

        // Then
        expect(store.getOutput()).toBe('one fallback\n');
        expect(store.getSnapshot().transcriptParts).toHaveLength(1);
        expect(store.getSnapshot().transcriptParts[0]?.type).toBe('assistant');
    });
});
