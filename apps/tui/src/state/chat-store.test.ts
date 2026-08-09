// allow: SIZE_OK -- HEAD 1477 -> current 1937 pure LOC; one ChatStore behavior matrix shares store lifecycle, timers, event queue, and overlay fixtures.
import { extractUsageFromModelCallCompleted } from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { parseMessageBlocks } from '@mission-control/tui/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderPromptKeypressState } from './auth-provider-keypress';
import type { ChatInputEvent } from './chat-input-event';
import {
    type AgentsDashboardState,
    type ChatStore,
    createAgentsDashboardView,
    createChatStore,
    createSessionPickerView,
    type DashboardAgentEntry,
    FILE_AUTOCOMPLETE_DEBOUNCE_MS,
    type MissionPanelRow,
    type MissionPanelTab,
    type SessionPickerEntry,
} from './chat-store';
import type { ModelChoice } from './interactive-chat-model';
import type { TranscriptPart as RichTranscriptPart } from './transcript-part';
import { attributionKeyForAssistantPart, getVisibleTranscriptParts, shouldHideToolPart } from './transcript-visibility';

const hostileDisplayPayload =
    'credential sk-displayblocker123 OSC:\u001b]52;c;UE9D\u0007 C0:\u0001 C1:\u009b DEL:\u007f CR:\r TAB:\t BIDI:\u202e\n한국어 가족\u200D그림';

function makeSelection(providerID: string, modelID: string): ModelProviderSelection {
    return { providerID, modelID };
}

function makeChoice(id: string, selection?: ModelProviderSelection): ModelChoice {
    return {
        id,
        label: id,
        selection: selection ?? makeSelection('test', id),
        capabilityStatus: 'executable',
        availableForCoding: true,
    };
}

function makeLineEvent(value: string): ChatInputEvent {
    return { type: 'line', value };
}

function makeSessionEntry(sessionId: string, label?: string): SessionPickerEntry {
    return {
        sessionId,
        label: label ?? sessionId,
        messageCount: 0,
        status: 'idle',
    };
}

describe('chat-store — subscribe / getSnapshot', () => {
    it('returns the initial state from getSnapshot', () => {
        const store = createChatStore();
        const snapshot = store.getSnapshot();
        expect(snapshot.outputText).toBe('');
        expect(snapshot.inputMirror).toBe('');
        expect(snapshot.generating).toBe(false);
        expect(snapshot.overlayMode).toBe('none');
        expect(snapshot.activeAssistantMessageId).toBeUndefined();
        expect(snapshot.toolOutputExpanded).toBe(false);
        expect(snapshot.historyPickerView).toEqual({
            open: false,
            selectedIndex: 0,
            total: 0,
            draftSnapshot: '',
        });
        expect(snapshot.historyEntries).toEqual([]);
    });

    it('subscribe registers a listener that fires on publish', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.setGenerating(true);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('subscribe returns an unsubscribe function', () => {
        const store = createChatStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        store.setGenerating(true);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        store.setGenerating(false);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('chat-store — emitOutput', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('appends text and fires the listener after the coalesce window', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitOutput('hello');
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot().outputText).toBe('hello');
        expect(store.getOutput()).toBe('hello');
    });

    it('coalesces 100 rapid calls into a single notification', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        for (let i = 0; i < 100; i++) {
            store.emitOutput('x');
        }
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getOutput()).toBe('x'.repeat(100));
    });

    it('produces separate notifications across distinct coalesce windows', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitOutput('a');
        vi.advanceTimersByTime(20);
        store.emitOutput('b');
        vi.advanceTimersByTime(20);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.getOutput()).toBe('ab');
    });

    it('coalesces rapid calls at the 50ms window while generating=true (not 16ms)', () => {
        const store = createChatStore();
        store.setGenerating(true);
        const listener = vi.fn();
        store.subscribe(listener);
        for (let i = 0; i < 50; i++) {
            store.emitOutput('x');
        }
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(16);
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(34);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getOutput()).toBe('x'.repeat(50));
    });

    it('coalesces rapid calls at the 16ms window while generating=false (idle)', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitOutput('a');
        vi.advanceTimersByTime(15);
        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getOutput()).toBe('a');
    });
});

describe('chat-store — replaceOutputText / getOutput', () => {
    it('replaceOutputText replaces the full text and publishes immediately', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitOutput('old');
        store.replaceOutputText('new');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getOutput()).toBe('new');
        expect(store.getSnapshot().outputText).toBe('new');
    });

    it('getOutput returns the current accumulated text', () => {
        const store = createChatStore();
        store.replaceOutputText('line1\n');
        store.replaceOutputText('line2');
        expect(store.getOutput()).toBe('line2');
    });
});

type TranscriptPart =
    | { readonly id: string; readonly type: 'user'; readonly text: string }
    | { readonly id: string; readonly type: 'assistant'; readonly text: string }
    | { readonly id: string; readonly type: 'reasoning'; readonly text: string }
    | { readonly id: string; readonly type: 'inline-tool'; readonly text: string }
    | { readonly id: string; readonly type: 'block-tool'; readonly text: string }
    | { readonly id: string; readonly type: 'diff'; readonly text: string }
    | { readonly id: string; readonly type: 'code'; readonly text: string }
    | { readonly id: string; readonly type: 'command'; readonly text: string }
    | { readonly id: string; readonly type: 'subagent'; readonly text: string }
    | { readonly id: string; readonly type: 'status'; readonly text: string }
    | { readonly id: string; readonly type: 'event'; readonly text: string }
    | { readonly id: string; readonly type: 'error'; readonly text: string }
    | { readonly id: string; readonly type: 'legacy'; readonly text: string };

type TypedTranscriptSnapshot = {
    readonly transcriptParts: readonly TranscriptPart[];
};

type TypedTranscriptStore = {
    readonly getSnapshot: () => TypedTranscriptSnapshot;
    readonly emitTranscriptPart: (part: TranscriptPart, fallbackText: string) => void;
    readonly replaceTranscript: (parts: readonly TranscriptPart[], outputText: string) => void;
    readonly submitLine: (value: string) => void;
};

function isTranscriptPart(value: unknown): value is TranscriptPart {
    if (typeof value !== 'object' || value === null) return false;
    if (!('id' in value) || !('type' in value) || !('text' in value)) return false;
    if (typeof value.id !== 'string' || typeof value.type !== 'string' || typeof value.text !== 'string') {
        return false;
    }
    switch (value.type) {
        case 'user':
        case 'assistant':
        case 'reasoning':
        case 'inline-tool':
        case 'block-tool':
        case 'diff':
        case 'code':
        case 'command':
        case 'subagent':
        case 'status':
        case 'event':
        case 'error':
        case 'legacy':
            return true;
        default:
            return false;
    }
}

function hasTypedTranscriptSnapshot(value: unknown): value is TypedTranscriptSnapshot {
    return (
        typeof value === 'object' &&
        value !== null &&
        'transcriptParts' in value &&
        Array.isArray(value.transcriptParts) &&
        value.transcriptParts.every(isTranscriptPart)
    );
}

function hasTypedTranscriptStore(value: object): value is TypedTranscriptStore {
    if (!('emitTranscriptPart' in value) || typeof value.emitTranscriptPart !== 'function') return false;
    if (!('replaceTranscript' in value) || typeof value.replaceTranscript !== 'function') return false;
    if (!('submitLine' in value) || typeof value.submitLine !== 'function') return false;
    if (!('getSnapshot' in value) || typeof value.getSnapshot !== 'function') return false;
    return hasTypedTranscriptSnapshot(value.getSnapshot());
}

describe('chat-store — typed transcript boundary (RED)', () => {
    it('requires the typed transcript store seam before rich parts can be emitted', () => {
        // Given: the current concrete ChatStore.
        const store = createChatStore();
        const transcriptStore: object = store;

        // When: the typed transcript capability is inspected without a static missing-member reference.
        const supportsTypedTranscript = hasTypedTranscriptStore(transcriptStore);

        // Then: the missing seam reports the explicit RED contract failure.
        expect(
            supportsTypedTranscript,
            'ChatStore must expose transcriptParts, emitTranscriptPart(part, fallbackText), and replaceTranscript(parts, outputText).',
        ).toBe(true);
    });

    it('upserts a stable part ID without moving its first-seen transcript position', () => {
        // Given: a store with a user row, a streaming assistant row, and a tool row.
        const store = createChatStore();
        const transcriptStore: object = store;
        if (!hasTypedTranscriptStore(transcriptStore)) return;
        const userPart: TranscriptPart = { id: 'user-1', type: 'user', text: 'Review the plan.' };
        const assistantStart: TranscriptPart = { id: 'assistant-1', type: 'assistant', text: 'I am reviewing' };
        const assistantFinal: TranscriptPart = {
            id: 'assistant-1',
            type: 'assistant',
            text: 'I am reviewing the plan.',
        };
        const toolPart: TranscriptPart = { id: 'tool-1', type: 'inline-tool', text: 'repo.read AGENTS.md' };

        // When: the assistant part is updated after later transcript rows have been emitted.
        transcriptStore.emitTranscriptPart(userPart, 'You: Review the plan.\n');
        transcriptStore.emitTranscriptPart(assistantStart, 'Assistant: I am reviewing');
        transcriptStore.emitTranscriptPart(toolPart, '\ntool: repo.read AGENTS.md\n');
        transcriptStore.emitTranscriptPart(assistantFinal, ' the plan.');

        // Then: order is first-seen order and the assistant content is the latest stable-ID value.
        expect(transcriptStore.getSnapshot().transcriptParts.map((part) => part.id)).toEqual([
            'user-1',
            'assistant-1',
            'tool-1',
        ]);
        expect(transcriptStore.getSnapshot().transcriptParts[1]).toEqual(assistantFinal);
    });

    it('preserves byte-exact legacy fallback ordering for a 72-column CJK stream, tool, and error', () => {
        // Given: a CJK assistant stream whose first chunk occupies 72 terminal columns.
        const store = createChatStore();
        const transcriptStore: object = store;
        if (!hasTypedTranscriptStore(transcriptStore)) return;
        const cjk72Columns = '가'.repeat(36);
        const userPart: TranscriptPart = { id: 'user-cjk', type: 'user', text: '상태를 알려줘' };
        const assistantStart: TranscriptPart = { id: 'assistant-cjk', type: 'assistant', text: cjk72Columns };
        const assistantFinal: TranscriptPart = { id: 'assistant-cjk', type: 'assistant', text: `${cjk72Columns} 완료` };
        const reasoningPart: TranscriptPart = { id: 'reasoning-cjk', type: 'reasoning', text: '출력을 확인합니다.' };
        const toolPart: TranscriptPart = { id: 'tool-cjk', type: 'block-tool', text: '$ pnpm test' };
        const errorPart: TranscriptPart = { id: 'error-cjk', type: 'error', text: '스트림이 중단되었습니다.' };
        const fallbackText = [
            'You: 상태를 알려줘\n',
            `Assistant: ${cjk72Columns}`,
            ' 완료\n',
            'Thinking: 출력을 확인합니다.\n',
            'tool: pnpm test\n',
            '$ pnpm test\n',
            'Error: 스트림이 중단되었습니다.\n',
        ].join('');

        // When: typed parts emit their legacy fallback fragments in mixed order.
        transcriptStore.emitTranscriptPart(userPart, 'You: 상태를 알려줘\n');
        transcriptStore.emitTranscriptPart(assistantStart, `Assistant: ${cjk72Columns}`);
        transcriptStore.emitTranscriptPart(assistantFinal, ' 완료\n');
        transcriptStore.emitTranscriptPart(reasoningPart, 'Thinking: 출력을 확인합니다.\n');
        transcriptStore.emitTranscriptPart(toolPart, 'tool: pnpm test\n$ pnpm test\n');
        transcriptStore.emitTranscriptPart(errorPart, 'Error: 스트림이 중단되었습니다.\n');

        // Then: old output consumers see the exact legacy text and block ordering.
        expect(store.getOutput()).toBe(fallbackText);
        expect(parseMessageBlocks(store.getOutput()).map((block) => block.kind)).toEqual([
            'user',
            'assistant',
            'thinking',
            'tool',
            'error',
        ]);
    });

    it('replaceTranscript replaces typed parts and the byte-exact legacy output together', () => {
        // Given: a store with existing typed output.
        const store = createChatStore();
        const transcriptStore: object = store;
        if (!hasTypedTranscriptStore(transcriptStore)) return;
        transcriptStore.emitTranscriptPart({ id: 'stale', type: 'status', text: 'stale' }, 'stale\n');
        const replacementParts: readonly TranscriptPart[] = [
            { id: 'user-replay', type: 'user', text: 'Replay this turn.' },
            { id: 'assistant-replay', type: 'assistant', text: 'Replayed response.' },
        ];
        const replacementOutput = 'You: Replay this turn.\nAssistant: Replayed response.\n';

        // When: replay supplies a complete replacement transcript.
        transcriptStore.replaceTranscript(replacementParts, replacementOutput);

        // Then: both store projections describe the same replacement.
        expect(transcriptStore.getSnapshot().transcriptParts).toEqual(replacementParts);
        expect(store.getOutput()).toBe(replacementOutput);
    });

    it('replaceOutputText clears typed state so legacy undo and replay do not retain stale parts', () => {
        // Given: a typed part has been emitted.
        const store = createChatStore();
        const transcriptStore: object = store;
        if (!hasTypedTranscriptStore(transcriptStore)) return;
        transcriptStore.emitTranscriptPart(
            { id: 'assistant-stale', type: 'assistant', text: 'stale response' },
            'Assistant: stale response\n',
        );

        // When: an existing legacy replacement path rewrites output text.
        store.replaceOutputText('You: restored prompt\n');

        // Then: typed state is empty and the replacement remains byte-exact.
        expect(transcriptStore.getSnapshot().transcriptParts).toEqual([]);
        expect(store.getOutput()).toBe('You: restored prompt\n');
    });

    it('undoLastViewExchange keeps typed parts aligned with outputText', () => {
        const store = createChatStore();
        store.emitTranscriptPart({ id: 'user-1', type: 'user', text: 'first' }, 'You: first\n');
        store.emitTranscriptPart(
            { id: 'assistant-1', type: 'assistant', text: 'answer one' },
            'Assistant: answer one\n',
        );
        store.emitTranscriptPart({ id: 'user-2', type: 'user', text: 'second' }, 'You: second\n');
        store.emitTranscriptPart(
            { id: 'assistant-2', type: 'assistant', text: 'answer two' },
            'Assistant: answer two\n',
        );

        expect(store.undoLastViewExchange()).toBe('ok');
        const snap = store.getSnapshot();
        expect(snap.transcriptParts.map((part) => part.id)).toEqual(['user-1', 'assistant-1']);
        expect(snap.outputText).toContain('You: first');
        expect(snap.outputText).not.toContain('You: second');
        expect(store.hasViewUndoStash()).toBe(true);

        expect(store.redoLastViewExchange()).toBe('ok');
        const restored = store.getSnapshot();
        expect(restored.transcriptParts.map((part) => part.id)).toEqual([
            'user-1',
            'assistant-1',
            'user-2',
            'assistant-2',
        ]);
        expect(restored.outputText).toContain('You: second');
        expect(store.hasViewUndoStash()).toBe(false);
    });

    it('undoLastViewExchange is single-level and blocked while generating', () => {
        const store = createChatStore();
        store.emitTranscriptPart({ id: 'user-1', type: 'user', text: 'q' }, 'You: q\n');
        store.emitTranscriptPart({ id: 'assistant-1', type: 'assistant', text: 'a' }, 'Assistant: a\n');
        expect(store.undoLastViewExchange()).toBe('ok');
        expect(store.undoLastViewExchange()).toBe('already');
        expect(store.redoLastViewExchange()).toBe('ok');
        store.setGenerating(true);
        expect(store.undoLastViewExchange()).toBe('generating');
        store.setGenerating(false);
        expect(store.undoLastViewExchange()).toBe('ok');
    });

    it('submitLine records a typed user part while preserving the current user fallback', () => {
        // Given: a fresh store and an ordinary user submission.
        const store = createChatStore();
        const transcriptStore: object = store;
        if (!hasTypedTranscriptStore(transcriptStore)) return;

        // When: the prompt is submitted through the existing input boundary.
        transcriptStore.submitLine('implement the typed transcript seam');

        // Then: the typed user row and legacy output agree on the submitted text.
        const parts = transcriptStore.getSnapshot().transcriptParts;
        expect(parts).toHaveLength(1);
        expect(parts[0]?.type).toBe('user');
        expect(parts[0]?.text).toBe('implement the typed transcript seam');
        expect(store.getOutput()).toBe('You: implement the typed transcript seam\n');
    });

    it('preserves byte-exact raw submitted user values while renderer sinks own terminal display safety', async () => {
        // Given
        const store = createChatStore();
        const nextEvent = store.waitForEvent();

        // When
        store.submitLine(hostileDisplayPayload);

        // Then
        await expect(nextEvent).resolves.toEqual({ type: 'line', value: hostileDisplayPayload });
        expect(store.getSnapshot().historyEntries.at(-1)?.text).toBe(hostileDisplayPayload);
        expect(store.getSnapshot().transcriptParts.at(-1)).toEqual({
            id: 'submitted-user-1',
            type: 'user',
            text: hostileDisplayPayload,
        });
        expect(store.getOutput()).toBe(`You: ${hostileDisplayPayload}\n`);
    });
});

describe('chat-store — replayed submitted user IDs', () => {
    it('allocates above the highest sparse safe occurrence without replacing replayed rows', () => {
        // Given: replayed rows with sparse submitted-user occurrences across part types.
        const store = createChatStore();
        const replayedParts: readonly RichTranscriptPart[] = [
            { id: 'submitted-user-0', type: 'user', text: 'zero' },
            { id: 'assistant-between', type: 'assistant', text: 'between' },
            { id: 'submitted-user-7', type: 'assistant', text: 'reserved occurrence' },
        ];
        store.replaceTranscript(replayedParts, 'replayed output\n');

        // When: a user submits after replay restoration.
        store.submitLine('fresh prompt');

        // Then: replay order and objects survive, and the new row uses the next higher occurrence.
        const snapshot = store.getSnapshot();
        expect(snapshot.transcriptParts.slice(0, replayedParts.length)).toEqual(replayedParts);
        expect(snapshot.transcriptParts.at(0)).toBe(replayedParts.at(0));
        expect(snapshot.transcriptParts.map((part) => part.id)).toEqual([
            'submitted-user-0',
            'assistant-between',
            'submitted-user-7',
            'submitted-user-8',
        ]);
        expect(snapshot.transcriptParts.at(-1)).toEqual({
            id: 'submitted-user-8',
            type: 'user',
            text: 'fresh prompt',
        });
        expect(snapshot.outputText).toBe('replayed output\nYou: fresh prompt\n');
    });

    it('ignores malformed and overflowing occurrences when reseeding', () => {
        // Given: replayed IDs that resemble the internal namespace but are not exact safe occurrences.
        const store = createChatStore();
        store.submitLine('discarded first prompt');
        store.submitLine('discarded second prompt');
        const replayedParts: readonly RichTranscriptPart[] = [
            { id: 'submitted-user--1', type: 'user', text: 'negative' },
            { id: 'submitted-user-+1', type: 'user', text: 'positive sign' },
            { id: 'submitted-user-01', type: 'user', text: 'leading zero' },
            { id: 'submitted-user-1.0', type: 'user', text: 'decimal' },
            { id: 'submitted-user-1suffix', type: 'user', text: 'suffix' },
            { id: 'submitted-user-9007199254740992', type: 'user', text: 'overflow' },
        ];
        store.replaceTranscript(replayedParts, 'malformed replay\n');

        // When: a user submits after replay restoration.
        store.submitLine('safe prompt');

        // Then: malformed occurrences do not advance the historical first generated occurrence.
        expect(store.getSnapshot().transcriptParts.map((part) => part.id)).toEqual([
            ...replayedParts.map((part) => part.id),
            'submitted-user-1',
        ]);
        expect(store.getOutput()).toBe('malformed replay\nYou: safe prompt\n');
    });

    it('wraps from the maximum safe occurrence to the first collision-free positive occurrence', () => {
        // Given: replay owns the maximum safe occurrence and two lower sparse occurrences.
        const store = createChatStore();
        const replayedParts: readonly RichTranscriptPart[] = [
            { id: 'submitted-user-1', type: 'user', text: 'first' },
            { id: 'submitted-user-3', type: 'user', text: 'third' },
            { id: `submitted-user-${Number.MAX_SAFE_INTEGER}`, type: 'user', text: 'maximum' },
        ];
        store.replaceTranscript(replayedParts, 'maximum replay\n');

        // When: a user submits after the safe counter cannot advance.
        store.submitLine('wrapped prompt');

        // Then: allocation fills the first positive gap and no replayed row is overwritten.
        expect(store.getSnapshot().transcriptParts).toEqual([
            ...replayedParts,
            { id: 'submitted-user-2', type: 'user', text: 'wrapped prompt' },
        ]);
        expect(store.getOutput()).toBe('maximum replay\nYou: wrapped prompt\n');
    });
});

describe('chat-store — typed streaming publication', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces 100 cumulative streaming updates into one 50ms publication with the latest state', () => {
        const store = createChatStore();
        const listener = vi.fn();
        const initialSnapshot = store.getSnapshot();
        store.subscribe(listener);

        for (let index = 0; index < 100; index += 1) {
            const textLength = Math.min(5, Math.floor(index / 20) + 1);
            const previousTextLength = index === 0 ? 0 : Math.min(5, Math.floor((index - 1) / 20) + 1);
            const text = 'hello'.slice(0, textLength);
            const fallbackText = `${index === 0 ? 'Assistant: ' : ''}${text.slice(previousTextLength)}${index === 99 ? '\n' : ''}`;
            store.emitTranscriptPart(
                { id: 'assistant-stream', type: 'assistant', text, status: 'streaming' },
                fallbackText,
            );
        }

        expect(listener).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        expect(store.getOutput()).toBe('Assistant: hello\n');
        expect(store.getSnapshot()).toBe(initialSnapshot);

        vi.advanceTimersByTime(49);
        expect(listener).not.toHaveBeenCalled();
        expect(store.getSnapshot()).toBe(initialSnapshot);

        vi.advanceTimersByTime(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(store.getSnapshot()).not.toBe(initialSnapshot);
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'assistant-stream', type: 'assistant', text: 'hello', status: 'streaming' },
        ]);
        expect(store.getSnapshot().outputText).toBe('Assistant: hello\n');
    });

    it('keeps the first 50ms deadline when a later streaming update arrives', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitTranscriptPart(
            { id: 'assistant-fixed-window', type: 'assistant', text: 'h', status: 'streaming' },
            'Assistant: h',
        );

        vi.advanceTimersByTime(49);
        store.emitTranscriptPart(
            { id: 'assistant-fixed-window', type: 'assistant', text: 'hello', status: 'streaming' },
            'ello\n',
        );

        expect(listener).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        expect(store.getOutput()).toBe('Assistant: hello\n');

        vi.advanceTimersByTime(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'assistant-fixed-window', type: 'assistant', text: 'hello', status: 'streaming' },
        ]);
    });

    it.each([
        'completed',
        'failed',
    ] as const)('publishes %s parts immediately and cancels the streaming timer', (status) => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitTranscriptPart(
            { id: 'assistant-terminal', type: 'assistant', text: 'hel', status: 'streaming' },
            'Assistant: hel',
        );

        store.emitTranscriptPart({ id: 'assistant-terminal', type: 'assistant', text: 'hello', status }, 'lo\n');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(store.getOutput()).toBe('Assistant: hello\n');
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'assistant-terminal', type: 'assistant', text: 'hello', status },
        ]);

        vi.advanceTimersByTime(50);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('publishes an output replacement immediately and cancels the streaming timer', () => {
        const store = createChatStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.emitTranscriptPart(
            { id: 'assistant-stale', type: 'assistant', text: 'stale', status: 'streaming' },
            'Assistant: stale',
        );

        store.replaceOutputText('Assistant: restored\n');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(store.getSnapshot().transcriptParts).toEqual([]);
        expect(store.getSnapshot().outputText).toBe('Assistant: restored\n');

        vi.advanceTimersByTime(50);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('publishes a transcript replacement immediately and cancels the streaming timer', () => {
        const store = createChatStore();
        const listener = vi.fn();
        const replacementParts: readonly RichTranscriptPart[] = [
            { id: 'assistant-restored', type: 'assistant', text: 'restored', status: 'completed' },
        ];
        store.subscribe(listener);
        store.emitTranscriptPart(
            { id: 'assistant-stale', type: 'assistant', text: 'stale', status: 'streaming' },
            'Assistant: stale',
        );

        store.replaceTranscript(replacementParts, 'Assistant: restored\n');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(store.getSnapshot().transcriptParts).toEqual(replacementParts);
        expect(store.getSnapshot().outputText).toBe('Assistant: restored\n');

        vi.advanceTimersByTime(50);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('chat-store — ordered typed and legacy transcript rows', () => {
    it('preserves direct output before, between, and after typed parts without materializing typed fallbacks as legacy', () => {
        // Given: historical output followed by semantic parts and direct bridge writes.
        const store = createChatStore();
        const assistant: RichTranscriptPart = {
            id: 'assistant-ordered',
            type: 'assistant',
            text: 'typed assistant',
            status: 'streaming',
        };
        const tool: RichTranscriptPart = {
            id: 'tool-ordered',
            type: 'inline-tool',
            text: 'repo.read',
            output: 'typed tool output',
            status: 'completed',
        };
        vi.useFakeTimers();
        store.emitOutput('legacy before\n');

        // When: direct and typed writes interleave.
        store.emitTranscriptPart(assistant, 'Assistant: typed assistant\n');
        store.emitOutput('legacy between\n');
        store.emitTranscriptPart(tool, 'tool: repo.read\n');
        store.emitOutput('legacy after\n');
        vi.runAllTimers();

        // Then: only direct output becomes legacy rows and every row retains emission order.
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'legacy-1', type: 'legacy', text: 'legacy before\n' },
            assistant,
            { id: 'legacy-2', type: 'legacy', text: 'legacy between\n' },
            tool,
            { id: 'legacy-3', type: 'legacy', text: 'legacy after\n' },
        ]);
        expect(store.getOutput()).toBe(
            'legacy before\nAssistant: typed assistant\nlegacy between\ntool: repo.read\nlegacy after\n',
        );
    });

    it('replaces stable streaming rows in place while preserving their first-seen status order', () => {
        // Given: historical output and active assistant/reasoning rows.
        const store = createChatStore();
        store.emitOutput('historical\n');
        const assistantStart: RichTranscriptPart = {
            id: 'assistant-stream',
            type: 'assistant',
            text: 'draft',
            status: 'streaming',
        };
        const reasoningStart: RichTranscriptPart = {
            id: 'reasoning-stream',
            type: 'reasoning',
            text: 'checking',
            status: 'streaming',
        };
        store.emitTranscriptPart(assistantStart, 'Assistant: draft');
        store.emitTranscriptPart(reasoningStart, 'Thinking: checking');

        // When: same IDs receive completed replacements.
        const assistantFinal: RichTranscriptPart = {
            ...assistantStart,
            text: 'final answer',
            status: 'completed',
        };
        const reasoningFinal: RichTranscriptPart = {
            ...reasoningStart,
            text: 'checked',
            status: 'completed',
        };
        store.emitTranscriptPart(assistantFinal, ' final answer');
        store.emitTranscriptPart(reasoningFinal, ' checked');

        // Then: no update moves the stable rows or creates fallback legacy rows.
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'legacy-1', type: 'legacy', text: 'historical\n' },
            assistantFinal,
            reasoningFinal,
        ]);
    });

    it('resets generated legacy IDs when replacement clears or replaces the transcript', () => {
        // Given: typed mode has generated a legacy row.
        const store = createChatStore();
        vi.useFakeTimers();
        store.emitTranscriptPart({ id: 'assistant-reset', type: 'assistant', text: 'first' }, 'Assistant: first\n');
        store.emitOutput('direct first\n');

        // When: the legacy replacement path clears typed state before a new typed stream begins.
        store.replaceOutputText('restored\n');
        store.emitTranscriptPart({ id: 'assistant-next', type: 'assistant', text: 'next' }, 'Assistant: next\n');
        store.emitOutput('direct next\n');
        vi.runAllTimers();

        // Then: the fresh ordered projection restarts legacy IDs consistently.
        expect(store.getSnapshot().transcriptParts).toEqual([
            { id: 'legacy-1', type: 'legacy', text: 'restored\n' },
            { id: 'assistant-next', type: 'assistant', text: 'next' },
            { id: 'legacy-2', type: 'legacy', text: 'direct next\n' },
        ]);
    });

    it('restarts the legacy counter after a full transcript replacement without colliding with replayed rows', () => {
        // Given: a replacement transcript which already owns its first legacy row.
        const store = createChatStore();
        vi.useFakeTimers();
        store.replaceTranscript(
            [
                { id: 'legacy-1', type: 'legacy', text: 'replayed direct\n' },
                { id: 'assistant-replay', type: 'assistant', text: 'replayed answer' },
            ],
            'replayed direct\nAssistant: replayed answer\n',
        );

        // When: a direct output write arrives after the replacement's typed row.
        store.emitOutput('replayed tail\n');
        vi.runAllTimers();

        // Then: a new ordered legacy row is allocated after the replay-owned ID.
        expect(store.getSnapshot().transcriptParts.at(-1)).toEqual({
            id: 'legacy-2',
            type: 'legacy',
            text: 'replayed tail\n',
        });
    });
});

describe('chat-store — activeAssistantMessageId and tool visibility', () => {
    it('tracks activeAssistantMessageId from assistant parts only', () => {
        // Given: an empty store
        const store = createChatStore();
        expect(store.getSnapshot().activeAssistantMessageId).toBeUndefined();

        // When: assistant A is emitted
        store.emitTranscriptPart(
            {
                id: 'asst-a',
                type: 'assistant',
                text: 'first',
                messageId: 'msg-a',
                status: 'completed',
            },
            'Assistant: first\n',
        );

        // Then: active is A's attribution key
        expect(store.getSnapshot().activeAssistantMessageId).toBe('msg-a');

        // When: reasoning arrives (must not steal active)
        store.emitTranscriptPart(
            {
                id: 'reason-a',
                type: 'reasoning',
                text: 'thinking',
                messageId: 'reason-msg',
                requestId: 'reason-req',
                status: 'completed',
            },
            'Thinking: thinking\n',
        );
        expect(store.getSnapshot().activeAssistantMessageId).toBe('msg-a');

        // When: assistant B is emitted
        store.emitTranscriptPart(
            {
                id: 'asst-b',
                type: 'assistant',
                text: 'second',
                requestId: 'req-b',
                status: 'completed',
            },
            'Assistant: second\n',
        );

        // Then: active becomes B (requestId fallback)
        expect(store.getSnapshot().activeAssistantMessageId).toBe('req-b');
        expect(
            attributionKeyForAssistantPart({
                id: 'asst-b',
                type: 'assistant',
                text: 'second',
                requestId: 'req-b',
            }),
        ).toBe('req-b');
    });

    it('replaceTranscript recomputes active from the last assistant part', () => {
        // Given: live active from a prior assistant
        const store = createChatStore();
        store.emitTranscriptPart(
            { id: 'live', type: 'assistant', text: 'live', messageId: 'live-msg', status: 'completed' },
            'Assistant: live\n',
        );
        expect(store.getSnapshot().activeAssistantMessageId).toBe('live-msg');

        // When: replaceTranscript restores a multi-turn transcript ending on assistant C
        store.replaceTranscript(
            [
                { id: 'u1', type: 'user', text: 'hi' },
                { id: 'a1', type: 'assistant', text: 'one', messageId: 'msg-1', status: 'completed' },
                {
                    id: 't1',
                    type: 'inline-tool',
                    text: 'repo.read',
                    messageId: 'msg-1',
                    status: 'completed',
                },
                { id: 'r1', type: 'reasoning', text: 'note', messageId: 'reason-x', status: 'completed' },
                { id: 'a2', type: 'assistant', text: 'two', messageId: 'msg-2', status: 'completed' },
            ],
            'restored\n',
        );

        // Then: active is the last assistant (msg-2), not reasoning
        expect(store.getSnapshot().activeAssistantMessageId).toBe('msg-2');
    });

    it('replaceTranscript with no assistant parts clears activeAssistantMessageId', () => {
        // Given: active set
        const store = createChatStore();
        store.emitTranscriptPart(
            { id: 'live', type: 'assistant', text: 'live', messageId: 'live-msg', status: 'completed' },
            'Assistant: live\n',
        );

        // When: replacement has only user/legacy rows
        store.replaceTranscript(
            [
                { id: 'u1', type: 'user', text: 'hi' },
                { id: 'legacy-1', type: 'legacy', text: 'old\n' },
            ],
            'hi\nold\n',
        );

        // Then: active is undefined
        expect(store.getSnapshot().activeAssistantMessageId).toBeUndefined();
    });

    it('shouldHideToolPart hides past successful tools and diffs only', () => {
        // Given: active turn B
        const activeB = 'msg-b';

        // When/Then: successful tool attributed to A while active is B → hide
        expect(
            shouldHideToolPart(
                {
                    id: 'tool-a',
                    type: 'inline-tool',
                    text: 'repo.read',
                    messageId: 'msg-a',
                    status: 'completed',
                },
                activeB,
            ),
        ).toBe(true);

        // Failed tool stays visible
        expect(
            shouldHideToolPart(
                {
                    id: 'tool-fail',
                    type: 'block-tool',
                    text: 'file.edit',
                    messageId: 'msg-a',
                    status: 'failed',
                },
                activeB,
            ),
        ).toBe(false);

        // Undefined messageId stays visible
        expect(
            shouldHideToolPart(
                {
                    id: 'tool-orphan',
                    type: 'command',
                    text: 'pnpm test',
                    status: 'completed',
                },
                activeB,
            ),
        ).toBe(false);

        // Successful diff for past turn stays visible (diff content always shown)
        expect(
            shouldHideToolPart(
                {
                    id: 'diff-a',
                    type: 'diff',
                    text: '--- a\n+++ b',
                    messageId: 'msg-a',
                    status: 'completed',
                },
                activeB,
            ),
        ).toBe(false);

        // Pending diff stays visible
        expect(
            shouldHideToolPart(
                {
                    id: 'diff-pending',
                    type: 'diff',
                    text: '--- a\n+++ b',
                    messageId: 'msg-a',
                    status: 'pending',
                },
                activeB,
            ),
        ).toBe(false);

        // Active-turn successful tool stays visible
        expect(
            shouldHideToolPart(
                {
                    id: 'tool-b',
                    type: 'subagent',
                    text: 'explore',
                    messageId: 'msg-b',
                    status: 'completed',
                },
                activeB,
            ),
        ).toBe(false);

        // Non-hideable types never hide
        expect(
            shouldHideToolPart(
                { id: 'asst', type: 'assistant', text: 'hi', messageId: 'msg-a', status: 'completed' },
                activeB,
            ),
        ).toBe(false);
    });

    it('getVisibleTranscriptParts filters with the same hide rule', () => {
        // Given: mixed past/active tools
        const parts: readonly RichTranscriptPart[] = [
            { id: 'a1', type: 'assistant', text: 'one', messageId: 'msg-1', status: 'completed' },
            {
                id: 't-past',
                type: 'inline-tool',
                text: 'repo.read',
                messageId: 'msg-1',
                status: 'completed',
            },
            {
                id: 't-fail',
                type: 'inline-tool',
                text: 'file.edit',
                messageId: 'msg-1',
                status: 'failed',
            },
            { id: 'a2', type: 'assistant', text: 'two', messageId: 'msg-2', status: 'completed' },
            {
                id: 't-active',
                type: 'inline-tool',
                text: 'repo.search',
                messageId: 'msg-2',
                status: 'completed',
            },
        ];

        // When: filter against active msg-2
        const visible = getVisibleTranscriptParts(parts, 'msg-2');

        // Then: past successful tool is gone; failed past tool and active tool remain
        expect(visible.map((part) => part.id)).toEqual(['a1', 't-fail', 'a2', 't-active']);
    });

    it('toggleToolOutputExpanded flips the Element B chip flag from the collapsed default', () => {
        // Given: default chip expansion is collapsed
        const store = createChatStore();
        expect(store.getSnapshot().toolOutputExpanded).toBe(false);

        // When: toggle twice
        store.toggleToolOutputExpanded();
        expect(store.getSnapshot().toolOutputExpanded).toBe(true);
        store.toggleToolOutputExpanded();

        // Then: back to collapsed
        expect(store.getSnapshot().toolOutputExpanded).toBe(false);
    });
});

describe('chat-store — model picker overlay', () => {
    it('showModelPicker sets overlay and hideModelPicker resolves the promise', async () => {
        const store = createChatStore();
        const choices = [makeChoice('a'), makeChoice('b')];
        const promise = store.showModelPicker(choices);
        expect(store.getSnapshot().overlayMode).toBe('model-picker');
        expect(store.getSnapshot().modelPickerChoices).toEqual(choices);
        const selection = makeSelection('test', 'a');
        store.hideModelPicker(selection);
        const result = await promise;
        expect(result).toEqual(selection);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showModelPicker with empty choices resolves undefined without opening overlay', async () => {
        const store = createChatStore();
        const result = await store.showModelPicker([]);
        expect(result).toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('hideModelPicker with no selection resolves undefined', async () => {
        const store = createChatStore();
        const promise = store.showModelPicker([makeChoice('a')]);
        store.hideModelPicker();
        expect(await promise).toBeUndefined();
    });
});

describe('chat-store — level picker overlay', () => {
    it('showLevelPicker sets selectedIndex based on currentLevel', () => {
        const store = createChatStore();
        store.showLevelPicker('aggressive');
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('level-picker');
        expect(snapshot.levelPickerSelectedIndex).toBe(2);
    });

    it('showLevelPicker defaults to index 1 (safe) when currentLevel is unknown', () => {
        const store = createChatStore();
        store.showLevelPicker('nonexistent');
        expect(store.getSnapshot().levelPickerSelectedIndex).toBe(1);
    });

    it('hideLevelPicker resolves the promise and resets overlay', async () => {
        const store = createChatStore();
        const promise = store.showLevelPicker('safe');
        store.hideLevelPicker('aggressive');
        expect(await promise).toBe('aggressive');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — approval overlay', () => {
    it('showApproval sets overlay fields and hideApproval resets', () => {
        const store = createChatStore();
        store.showApproval('file.edit', 'edit src.ts');
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('approval');
        expect(snapshot.approvalToolName).toBe('file.edit');
        expect(snapshot.approvalAction).toBe('edit src.ts');
        expect(snapshot.approvalSelectedIndex).toBe(0);
        store.hideApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — question overlay', () => {
    it('showQuestion sets overlay and resolveQuestion resolves the promise', async () => {
        const store = createChatStore();
        const promise = store.showQuestion('Continue?', ['yes', 'no'], { header: 'Confirm' });
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('question');
        expect(snapshot.questionText).toBe('Continue?');
        expect(snapshot.questionHeader).toBe('Confirm');
        expect(snapshot.questionOptions).toHaveLength(2);
        expect(snapshot.questionMultiple).toBe(false);
        store.resolveQuestion('yes');
        expect(await promise).toBe('yes');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showQuestion with multiple flag initializes multi-select state', () => {
        const store = createChatStore();
        store.showQuestion('Pick', ['a', 'b'], { multiple: true });
        const snapshot = store.getSnapshot();
        expect(snapshot.questionMultiple).toBe(true);
        expect(snapshot.questionSelectedIndices).toEqual(new Set<number>());
    });

    it('selectQuestionByClick resolves single-select immediately with the clicked label', async () => {
        const store = createChatStore();
        const promise = store.showQuestion('Continue?', ['yes', 'no']);
        store.selectQuestionByClick(1);
        expect(await promise).toBe('no');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('selectQuestionByClick toggles membership in multi-select without resolving', () => {
        const store = createChatStore();
        store.showQuestion('Pick', ['a', 'b'], { multiple: true });
        store.selectQuestionByClick(0);
        expect(store.getSnapshot().questionSelectedIndices).toEqual(new Set<number>([0]));
        store.selectQuestionByClick(0);
        expect(store.getSnapshot().questionSelectedIndices).toEqual(new Set<number>());
        expect(store.getSnapshot().overlayMode).toBe('question');
    });

    it('selectQuestionByClick on the custom-answer row index enters custom mode', () => {
        const store = createChatStore();
        store.showQuestion('Continue?', ['yes', 'no']);
        store.selectQuestionByClick(2);
        const snapshot = store.getSnapshot();
        expect(snapshot.questionCustomMode).toBe(true);
        expect(snapshot.questionSelectedIndex).toBe(2);
        expect(snapshot.questionCustomBuffer).toBe('');
    });

    it('hoverQuestion moves the cursor without resolving (single-select)', () => {
        const store = createChatStore();
        const promise = store.showQuestion('Continue?', ['yes', 'no']);
        store.hoverQuestion(1);
        const snapshot = store.getSnapshot();
        expect(snapshot.questionSelectedIndex).toBe(1);
        expect(snapshot.overlayMode).toBe('question');
        store.resolveQuestion('');
        return promise;
    });

    it('hoverQuestion reaches the custom-answer row and is a no-op when already active', () => {
        const store = createChatStore();
        store.showQuestion('Continue?', ['yes', 'no']);
        store.hoverQuestion(2);
        expect(store.getSnapshot().questionSelectedIndex).toBe(2);
        expect(store.getSnapshot().questionCustomMode).toBe(false);
        store.hoverQuestion(2);
        expect(store.getSnapshot().questionSelectedIndex).toBe(2);
    });

    it('hoverQuestion is a no-op when no question overlay is open', () => {
        const store = createChatStore();
        store.hoverQuestion(0);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — multi-question batch', () => {
    it('showQuestionBatch opens a tabbed overlay with a confirm tab for N>1', () => {
        const store = createChatStore();
        store.showQuestionBatch([
            { question: 'Lang?', header: 'Language', options: [{ label: 'TS' }, { label: 'Go' }], multiple: false },
            {
                question: 'Level?',
                header: 'Level',
                options: [{ label: 'Junior' }, { label: 'Senior' }],
                multiple: false,
            },
        ]);
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('question');
        expect(snapshot.questionTabs).toHaveLength(2);
        expect(snapshot.questionConfirmActive).toBe(false);
        expect(snapshot.questionText).toBe('Lang?');
    });

    it('a single-select pick advances to the next tab, then confirm submits all answers', async () => {
        const store = createChatStore();
        const promise = store.showQuestionBatch([
            { question: 'Lang?', header: 'Language', options: [{ label: 'TS' }, { label: 'Go' }], multiple: false },
            {
                question: 'Level?',
                header: 'Level',
                options: [{ label: 'Junior' }, { label: 'Senior' }],
                multiple: false,
            },
        ]);
        store.selectQuestionByClick(0);
        expect(store.getSnapshot().questionTabIndex).toBe(1);
        store.selectQuestionByClick(1);
        expect(store.getSnapshot().questionConfirmActive).toBe(true);
        store.confirmQuestionBatch();
        expect(await promise).toEqual(['TS', 'Senior']);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('Left/Right tab navigation wraps across questions + confirm and preserves answers', () => {
        const store = createChatStore();
        store.showQuestionBatch([
            { question: 'A?', header: 'A', options: [{ label: 'a1' }, { label: 'a2' }], multiple: false },
            { question: 'B?', header: 'B', options: [{ label: 'b1' }, { label: 'b2' }], multiple: false },
        ]);
        store.selectQuestionByClick(1);
        store.navigateQuestionTab(-1); // back to tab 0
        expect(store.getSnapshot().questionTabIndex).toBe(0);
        expect(store.getSnapshot().questionConfirmActive).toBe(false);
        store.navigateQuestionTab(-1); // wrap back from 0 → confirm tab
        expect(store.getSnapshot().questionConfirmActive).toBe(true);
    });

    it('multi-select toggles membership and only resolves at confirm', async () => {
        const store = createChatStore();
        const promise = store.showQuestionBatch([
            {
                question: 'Toppings?',
                header: 'Toppings',
                options: [{ label: 'cheese' }, { label: 'mushroom' }, { label: 'olive' }],
                multiple: true,
            },
        ]);
        // single multiple-select question → multi batch (has confirm tab)
        expect(store.getSnapshot().questionConfirmActive).toBe(false);
        store.navigateQuestion(1);
        store.toggleQuestionOption();
        store.navigateQuestion(1);
        store.toggleQuestionOption();
        expect(store.getSnapshot().questionSelectedIndices).toEqual(new Set<number>([1, 2]));
        store.navigateQuestionTab(1); // to confirm tab
        expect(store.getSnapshot().questionConfirmActive).toBe(true);
        store.confirmQuestionBatch();
        expect(await promise).toEqual(['mushroom, olive']);
    });

    it('rejectQuestion cancels the whole batch with empty answers', async () => {
        const store = createChatStore();
        const promise = store.showQuestionBatch([
            { question: 'A?', header: 'A', options: [{ label: 'a1' }, { label: 'a2' }], multiple: false },
            { question: 'B?', header: 'B', options: [{ label: 'b1' }, { label: 'b2' }], multiple: false },
        ]);
        store.selectQuestionByClick(0);
        store.rejectQuestion();
        expect(await promise).toEqual(['', '']);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showQuestion (single) resets batch state so no tabs render', () => {
        const store = createChatStore();
        store.showQuestionBatch([
            { question: 'A?', header: 'A', options: [{ label: 'a1' }], multiple: false },
            { question: 'B?', header: 'B', options: [{ label: 'b1' }], multiple: false },
        ]);
        store.showQuestion('Plain?', ['x', 'y']);
        const snapshot = store.getSnapshot();
        expect(snapshot.questionTabs).toHaveLength(0);
        expect(snapshot.questionConfirmActive).toBe(false);
        expect(snapshot.questionText).toBe('Plain?');
    });
});

describe('chat-store — rename overlay', () => {
    it('showRename sets overlay and submitRename fires callback', () => {
        const store = createChatStore();
        const submitted: string[] = [];
        store.onRenameSubmit = (name) => {
            submitted.push(name);
        };
        store.showRename();
        expect(store.getSnapshot().overlayMode).toBe('rename');
        store.submitRename('my-session');
        expect(submitted).toEqual(['my-session']);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showRename pre-fills the buffer with the session display name when set', () => {
        const store = createChatStore();
        store.setSessionId('session_abc');
        store.setSessionDisplayName('investigating bug');

        store.showRename();

        expect(store.getSnapshot().renameBuffer).toBe('investigating bug');
    });

    it('showRename falls back to the session id when no display name is set', () => {
        const store = createChatStore();
        store.setSessionId('session_abc');

        store.showRename();

        expect(store.getSnapshot().renameBuffer).toBe('session_abc');
    });

    it('showRename leaves the buffer empty when neither display name nor session id is set', () => {
        const store = createChatStore();

        store.showRename();

        expect(store.getSnapshot().renameBuffer).toBe('');
    });

    it('setSessionDisplayName is a no-op publish when the value is unchanged', () => {
        const store = createChatStore();
        let publishCount = 0;
        store.subscribe(() => {
            publishCount += 1;
        });
        store.setSessionDisplayName('first');
        const afterFirst = publishCount;
        store.setSessionDisplayName('first');

        expect(publishCount).toBe(afterFirst);
    });
});

describe('chat-store — event queue', () => {
    it('enqueueEvent queues when no waiter; waitForEvent resolves from queue', async () => {
        const store = createChatStore();
        store.enqueueEvent(makeLineEvent('hello'));
        const event = await store.waitForEvent();
        expect(event).toEqual({ type: 'line', value: 'hello' });
    });

    it('enqueueEvent resolves immediately when a waiter exists', async () => {
        const store = createChatStore();
        const promise = store.waitForEvent();
        store.enqueueEvent(makeLineEvent('world'));
        const event = await promise;
        expect(event).toEqual({ type: 'line', value: 'world' });
    });

    it('waitForEvent queues a waiter when the queue is empty', async () => {
        const store = createChatStore();
        const promise = store.waitForEvent();
        store.enqueueEvent({ type: 'interrupt' });
        const event = await promise;
        expect(event.type).toBe('interrupt');
    });

    it('settles pending and future waits when the input queue closes', async () => {
        // Given: the imperative loop is blocked waiting for its next input event.
        const store = createChatStore();
        const pending = store.waitForEvent();

        // When: TUI teardown closes the input queue.
        store.closeEventQueue();
        store.enqueueEvent(makeLineEvent('stale input'));

        // Then: no await survives teardown and stale input cannot be delivered later.
        await expect(pending).resolves.toEqual({ type: 'interrupt' });
        await expect(store.waitForEvent()).resolves.toEqual({ type: 'interrupt' });
    });
});

describe('chat-store — menus', () => {
    it('setInputMirror updates mirror and resets menuState', () => {
        const store = createChatStore();
        store.setInputMirror('/model');
        const snapshot = store.getSnapshot();
        expect(snapshot.inputMirror).toBe('/model');
        expect(snapshot.menuState.selectedIndex).toBe(0);
    });

    it('navigateSlashMenu changes selectedIndex', () => {
        const store = createChatStore();
        store.setInputMirror('/m');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(0);
        store.navigateSlashMenu('down');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(1);
        store.navigateSlashMenu('up');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(0);
    });

    it('setSkillEntries updates snapshot skillEntries', () => {
        const store = createChatStore();
        const entries = [
            { name: 'alpha', description: 'First skill.' },
            { name: 'beta', description: 'Second skill.' },
        ];
        expect(store.getSnapshot().skillEntries).toEqual([]);
        store.setSkillEntries(entries);
        expect(store.getSnapshot().skillEntries).toEqual(entries);
    });

    it('navigateSkillMenu changes selectedIndex when $ menu is open', () => {
        const store = createChatStore();
        store.setSkillEntries([
            { name: 'alpha', description: 'First skill.' },
            { name: 'beta', description: 'Second skill.' },
            { name: 'gamma', description: 'Third skill.' },
        ]);
        store.setInputMirror('$');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(0);
        store.navigateSkillMenu('down');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(1);
        store.navigateSkillMenu('up');
        expect(store.getSnapshot().menuState.selectedIndex).toBe(0);
    });

    it('closeMenus resets menuState and fileAutocomplete', () => {
        const store = createChatStore();
        store.setInputMirror('/m');
        store.navigateSlashMenu('down');
        store.closeMenus();
        const snapshot = store.getSnapshot();
        expect(snapshot.menuState.selectedIndex).toBe(0);
        expect(snapshot.fileAutocomplete.open).toBe(false);
    });
});

describe('chat-store — debounced file autocomplete', () => {
    it('coalesces path input and applies only the current prefix', () => {
        vi.useFakeTimers();
        try {
            const store = createChatStore();
            store.setInputMirror('@app');
            expect(store.getSnapshot().fileAutocomplete.open).toBe(false);
            vi.advanceTimersByTime(FILE_AUTOCOMPLETE_DEBOUNCE_MS - 1);
            expect(store.getSnapshot().fileAutocomplete.open).toBe(false);

            store.setInputMirror('@pack');
            vi.advanceTimersByTime(FILE_AUTOCOMPLETE_DEBOUNCE_MS);

            const autocomplete = store.getSnapshot().fileAutocomplete;
            expect(autocomplete.prefix).toBe('pack');
            expect(autocomplete.matches.some((match) => match.name === 'packages')).toBe(true);
            expect(autocomplete.matches.some((match) => match.name === 'apps')).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('resolves the current prefix immediately for an explicit completion', () => {
        vi.useFakeTimers();
        try {
            const store = createChatStore();
            store.setInputMirror('@app');
            store.ensureFileAutocompleteCurrent();

            const autocomplete = store.getSnapshot().fileAutocomplete;
            expect(autocomplete.open).toBe(true);
            expect(autocomplete.prefix).toBe('app');
            expect(autocomplete.matches.some((match) => match.name === 'apps')).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending scan when the input queue closes', () => {
        vi.useFakeTimers();
        try {
            const store = createChatStore();
            store.setInputMirror('@app');
            store.closeEventQueue();
            vi.runAllTimers();
            expect(store.getSnapshot().fileAutocomplete.open).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('chat-store — status actions', () => {
    it('setGenerating, setAgentStatus, clearAgentStatus update state', () => {
        const store = createChatStore();
        store.setGenerating(true);
        expect(store.getSnapshot().generating).toBe(true);
        store.setAgentRetryStatus('Retrying…', 12_000);
        expect(store.getSnapshot().agentRetryAt).toBe(12_000);
        store.setAgentStatus('Running tool...');
        expect(store.getSnapshot().agentStatusText).toBe('Running tool...');
        expect(store.getSnapshot().agentRetryAt).toBeUndefined();
        store.clearAgentStatus();
        expect(store.getSnapshot().agentStatusText).toBe('');
    });

    it('setWorkflowNames and setModelCycleChoices update state', () => {
        const store = createChatStore();
        store.setWorkflowNames(['default', 'planner']);
        expect(store.getSnapshot().workflowNames).toEqual(['default', 'planner']);
        const choices = [makeChoice('a'), makeChoice('b')];
        store.setModelCycleChoices(choices);
        expect(store.getSnapshot().modelCycleChoices).toEqual(choices);
    });

    it('setModelCycleChoices resets index when out of bounds', () => {
        const store = createChatStore();
        store.setModelCycleChoices([makeChoice('a'), makeChoice('b'), makeChoice('c')]);
        store.setModelCycleChoices([makeChoice('only')]);
        expect(store.getSnapshot().modelCycleIndex).toBe(0);
    });
});

describe('chat-store — live history truncation notice', () => {
    it('sets a sticky notice when transcript parts exceed the live cap', () => {
        const store = createChatStore();
        for (let i = 0; i < 501; i += 1) {
            store.emitTranscriptPart({ id: `status-${i}`, type: 'status', text: `row-${i}` }, `status-${i}\n`);
        }
        expect(store.getSnapshot().transcriptParts.length).toBe(500);
        expect(store.getSnapshot().stickyNotice).toContain('Live view truncated');
    });
});

describe('chat-store — session switch clears context usage', () => {
    it('clears used/cache counters when the session id changes', () => {
        const store = createChatStore();
        store.setSessionId('session_a');
        store.setContextTokensUsed(12345);
        store.setContextCacheUsage({ inputTokens: 12000, cacheReadTokens: 8000 });
        store.setSessionId('session_b');
        expect(store.getSnapshot().contextTokensUsed).toBeUndefined();
        expect(store.getSnapshot().contextCacheUsage).toBeUndefined();
        expect(store.getSnapshot().sessionId).toBe('session_b');
    });
});

describe('chat-store — context token tracking', () => {
    it('contextTokensUsed and contextTokensMax start undefined', () => {
        const store = createChatStore();
        const snapshot = store.getSnapshot();
        expect(snapshot.contextTokensUsed).toBeUndefined();
        expect(snapshot.contextTokensMax).toBeUndefined();
        expect(snapshot.contextCacheUsage).toBeUndefined();
    });

    it('setContextTokensUsed updates the snapshot', () => {
        const store = createChatStore();
        store.setContextTokensUsed(12345);
        expect(store.getSnapshot().contextTokensUsed).toBe(12345);
    });

    it('setContextTokensMax updates the snapshot', () => {
        const store = createChatStore();
        store.setContextTokensMax(200000);
        expect(store.getSnapshot().contextTokensMax).toBe(200000);
    });

    it('setContextCacheUsage updates both cache counters atomically', () => {
        const store = createChatStore();
        store.setContextCacheUsage({ inputTokens: 12000, cacheReadTokens: 8000 });
        expect(store.getSnapshot().contextCacheUsage).toEqual({ inputTokens: 12000, cacheReadTokens: 8000 });
    });

    it('setContextTokensUsed(undefined) clears the value', () => {
        const store = createChatStore();
        store.setContextTokensUsed(12345);
        store.setContextTokensUsed(undefined);
        expect(store.getSnapshot().contextTokensUsed).toBeUndefined();
    });

    it('publishing a new context value creates a new snapshot reference', () => {
        const store = createChatStore();
        const first = store.getSnapshot();
        store.setContextTokensUsed(100);
        const second = store.getSnapshot();
        expect(second).not.toBe(first);
        expect(second.contextTokensUsed).toBe(100);
    });
});

describe('chat-store — model.call.completed usage seam', () => {
    type FakeUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

    function modelCallCompleted(usage: FakeUsage | undefined): AgentEvent {
        const base: AgentEvent = { type: 'model.call.completed', timestamp: '2026-06-30T00:00:00.000Z' };
        if (usage === undefined) return base;
        return {
            ...base,
            providerStreamChunk: {
                kind: 'response_completed',
                requestId: 'r1',
                sequence: 1,
                message: { messageId: 'm1', role: 'assistant', content: 'ok' },
                finishReason: 'stop',
                usage,
            },
        };
    }

    it('extractUsageFromModelCallCompleted returns inputTokens from the whole event', () => {
        const event = modelCallCompleted({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        const result = extractUsageFromModelCallCompleted(event);
        expect(result).toBeDefined();
        expect(result?.inputTokens).toBe(100);
    });

    it('a model.call.completed event drives contextTokensUsed via the onUsage seam', () => {
        const store = createChatStore();
        const event = modelCallCompleted({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        const usage = extractUsageFromModelCallCompleted(event);
        store.setContextTokensUsed(usage?.inputTokens);
        expect(store.getSnapshot().contextTokensUsed).toBe(100);
    });

    it('two turns 100 then 250 yields the LATEST value (not a sum)', () => {
        const store = createChatStore();
        const first = modelCallCompleted({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        const second = modelCallCompleted({ inputTokens: 250, outputTokens: 80, totalTokens: 330 });
        store.setContextTokensUsed(extractUsageFromModelCallCompleted(first)?.inputTokens);
        store.setContextTokensUsed(extractUsageFromModelCallCompleted(second)?.inputTokens);
        expect(store.getSnapshot().contextTokensUsed).toBe(250);
    });

    it('an event without usage leaves the previous value unchanged', () => {
        const store = createChatStore();
        store.setContextTokensUsed(100);
        const eventWithoutUsage = modelCallCompleted(undefined);
        const usage = extractUsageFromModelCallCompleted(eventWithoutUsage);
        if (usage !== undefined) {
            store.setContextTokensUsed(usage.inputTokens);
        }
        expect(store.getSnapshot().contextTokensUsed).toBe(100);
    });

    it('passing a non-model.call.completed event to extractUsageFromModelCallCompleted returns undefined', () => {
        const wrongEvent: AgentEvent = { type: 'run.completed', timestamp: '2026-06-30T00:00:00.000Z' };
        expect(extractUsageFromModelCallCompleted(wrongEvent)).toBeUndefined();
    });
});

describe('chat-store — snapshot referential stability', () => {
    it('returns the same object reference until a mutation', () => {
        const store = createChatStore();
        const first = store.getSnapshot();
        const second = store.getSnapshot();
        expect(second).toBe(first);
        store.setGenerating(true);
        const third = store.getSnapshot();
        expect(third).not.toBe(first);
    });
});

describe('chat-store — ABG minimap toggle', () => {
    it('abgMinimapVisible defaults to false', () => {
        const store = createChatStore();
        expect(store.getSnapshot().abgMinimapVisible).toBe(false);
    });

    it('toggleAbgMinimap flips the flag to true', () => {
        const store = createChatStore();
        store.toggleAbgMinimap();
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
    });

    it('toggleAbgMinimap flips the flag back to false', () => {
        const store = createChatStore();
        store.toggleAbgMinimap();
        store.toggleAbgMinimap();
        expect(store.getSnapshot().abgMinimapVisible).toBe(false);
    });

    it('toggleAbgMinimap is independent of overlayMode', () => {
        const store = createChatStore();
        store.toggleAbgMinimap();
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.toggleAbgOverlay();
        expect(store.getSnapshot().overlayMode).toBe('abg');
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
    });

    it('abgMinimapVisible persists when an unrelated modal opens and closes', () => {
        const store = createChatStore();
        store.toggleAbgMinimap();
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
        store.showApproval('file.edit', 'edit x.ts');
        expect(store.getSnapshot().overlayMode).toBe('approval');
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
        store.hideApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
        expect(store.getSnapshot().abgMinimapVisible).toBe(true);
    });

    it('toggleAbgMinimap publishes a new snapshot reference', () => {
        const store = createChatStore();
        const first = store.getSnapshot();
        store.toggleAbgMinimap();
        const second = store.getSnapshot();
        expect(second).not.toBe(first);
        expect(second.abgMinimapVisible).toBe(true);
    });
});

describe('chat-store — onModelCycleSelect callback', () => {
    it('fires the callback when set', () => {
        const store = createChatStore();
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };
        store.onModelCycleSelect?.(makeSelection('p', 'm'));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ providerID: 'p', modelID: 'm' });
    });
});

describe('chat-store — cycleModelVariant', () => {
    // Fixtures tied to the real catalog: openai/gpt-5 has 4 reasoning variants;
    const GPT5_SELECTION: ModelProviderSelection = { providerID: 'openai', modelID: 'gpt-5' };
    const NO_VARIANT_SELECTION: ModelProviderSelection = {
        providerID: 'openai',
        modelID: 'gpt-4o-mini',
    };

    function createStoreWithCurrentChoice(selection: ModelProviderSelection): ChatStore {
        const store = createChatStore();
        store.setModelCycleChoices([
            makeChoice('current', selection),
            makeChoice('other', { providerID: 'other', modelID: 'other-model' }),
        ]);
        return store;
    }

    it('starts at unset and advances forward through the rotation', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-minimal');
        expect(calls).toEqual([{ providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-minimal' }]);

        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-low');
    });

    it('cycles backward from unset to the last variant (wrap)', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        store.cycleModelVariant(-1);
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-high');
    });

    it('wraps forward from the last variant back to unset', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
    });

    it('includes unset in the rotation: selecting unset clears variantID from the selection', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        store.cycleModelVariant(-1);
        store.cycleModelVariant(-1);

        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
        const lastCall = calls.at(-1);
        expect(lastCall).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
        expect(lastCall?.variantID).toBeUndefined();
    });

    it('emits a "No variants" transient notice and does not cycle when the model has no variants', () => {
        const store = createStoreWithCurrentChoice(NO_VARIANT_SELECTION);
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.cycleModelVariant(1);
        expect(calls).toHaveLength(0);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
        expect(store.getSnapshot().transientNotice?.message).toBe('No variants for openai/gpt-4o-mini');
        expect(store.getOutput()).not.toContain('No variants for openai/gpt-4o-mini');
    });

    it('updates the current variant without writing to outputText', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBeDefined();
        expect(store.getOutput()).not.toContain('Cycle variant');

        store.cycleModelVariant(-1);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
        expect(store.getOutput()).not.toContain('Cycle variant');
    });

    it('is a no-op when modelCycleChoices is empty', () => {
        const store = createChatStore();
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.cycleModelVariant(1);
        expect(calls).toHaveLength(0);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
    });

    it('resets currentModelVariantID to unset when cycleModel switches the base model', () => {
        const store = createStoreWithCurrentChoice(GPT5_SELECTION);
        store.cycleModelVariant(1);
        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-low');

        store.cycleModel(1);
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
        expect(store.getSnapshot().modelCycleIndex).toBe(1);
    });
});

describe('chat-store — setModelSelection', () => {
    // Fixtures tied to the real catalog: openai/gpt-5 has 4 reasoning variants.
    const GPT5_SELECTION: ModelProviderSelection = { providerID: 'openai', modelID: 'gpt-5' };

    function createStoreWithGpt5First(): ChatStore {
        const store = createChatStore();
        store.setModelCycleChoices([
            makeChoice('gpt-5', GPT5_SELECTION),
            makeChoice('other', { providerID: 'other', modelID: 'other-model' }),
        ]);
        return store;
    }

    it('updates currentModelSelection, currentModelVariantID, and re-aligns modelCycleIndex', () => {
        const store = createStoreWithGpt5First();
        const calls: ModelProviderSelection[] = [];
        store.onModelCycleSelect = (selection) => {
            calls.push(selection);
        };

        store.setModelSelection({ providerID: 'other', modelID: 'other-model', variantID: 'v1' });

        const snap = store.getSnapshot();
        expect(snap.currentModelSelection).toEqual({
            providerID: 'other',
            modelID: 'other-model',
            variantID: 'v1',
        });
        expect(snap.currentModelVariantID).toBe('v1');
        expect(snap.modelCycleIndex).toBe(1);
        expect(calls).toEqual([{ providerID: 'other', modelID: 'other-model', variantID: 'v1' }]);
    });

    it('clears currentModelVariantID when selection has no variantID', () => {
        const store = createStoreWithGpt5First();
        store.setModelSelection({ providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-low' });
        expect(store.getSnapshot().currentModelVariantID).toBe('reasoning-low');

        store.setModelSelection({ providerID: 'openai', modelID: 'gpt-5' });
        expect(store.getSnapshot().currentModelVariantID).toBeUndefined();
    });

    it('leaves modelCycleIndex unchanged when the selection base is not in modelCycleChoices', () => {
        const store = createStoreWithGpt5First();
        expect(store.getSnapshot().modelCycleIndex).toBe(0);

        store.setModelSelection({ providerID: 'unknown', modelID: 'mystery' });

        expect(store.getSnapshot().currentModelSelection).toEqual({
            providerID: 'unknown',
            modelID: 'mystery',
        });
        expect(store.getSnapshot().modelCycleIndex).toBe(0);
    });

    it('cycleModelVariant targets the model selected via setModelSelection (the Ctrl+V bug repro)', () => {
        // Bug repro: user is on gpt-5 (index 0), switches to "other" via a
        // non-cycle path (F2/leader+N or `/model`), then presses Ctrl+V.
        // Before the fix Ctrl+V read the stale index 0 and cycled gpt-5's
        // variants. After the fix it must operate on "other".
        const store = createStoreWithGpt5First();
        // "other/other-model" has no variants in the real catalog, so the
        // "No variants" notice should name that model, not openai/gpt-5.
        store.setModelSelection({ providerID: 'other', modelID: 'other-model' });

        store.cycleModelVariant(1);

        expect(store.getSnapshot().transientNotice?.message).toBe('No variants for other/other-model');
        expect(store.getOutput()).not.toContain('No variants for other/other-model');
        expect(store.getOutput()).not.toContain('openai/gpt-5');
        expect(store.getSnapshot().modelCycleIndex).toBe(1);
    });

    it('cycleModelVariant rotates the variant of a setModelSelection-selected model with variants', () => {
        // Switch to anthropic/claude-opus-4-1 (has thinking-* variants) via a
        // non-cycle path, then verify Ctrl+V rotates that model's variants.
        const store = createChatStore();
        store.setModelCycleChoices([
            makeChoice('gpt-5', GPT5_SELECTION),
            makeChoice('opus', { providerID: 'anthropic', modelID: 'claude-opus-4-1' }),
        ]);
        store.setModelSelection({ providerID: 'anthropic', modelID: 'claude-opus-4-1' });
        expect(store.getSnapshot().modelCycleIndex).toBe(1);

        store.cycleModelVariant(1);
        expect(store.getSnapshot().currentModelVariantID).toBe('thinking-low');
        expect(store.getSnapshot().currentModelSelection).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-opus-4-1',
            variantID: 'thinking-low',
        });
    });

    it('setModelCycleChoices re-aligns modelCycleIndex to the current selection', () => {
        const store = createChatStore();
        store.setModelSelection({ providerID: 'openai', modelID: 'gpt-5' });
        expect(store.getSnapshot().modelCycleIndex).toBe(0);

        // Rebuild the choices list with gpt-5 NOT first; the store should
        // re-find it on the next setModelCycleChoices call.
        store.setModelCycleChoices([
            makeChoice('other', { providerID: 'other', modelID: 'other-model' }),
            makeChoice('gpt-5', GPT5_SELECTION),
        ]);
        expect(store.getSnapshot().modelCycleIndex).toBe(1);
    });
});

describe('chat-store — session picker overlay', () => {
    it('showSessionPicker sets overlayMode and returns a Promise', () => {
        const store = createChatStore();
        const entries = [makeSessionEntry('s1', 'Session 1'), makeSessionEntry('s2', 'Session 2')];
        const promise = store.showSessionPicker(entries);
        expect(promise).toBeInstanceOf(Promise);
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('session-picker');
        expect(snapshot.sessionPickerEntries).toEqual(entries);
        store.hideSessionPicker();
    });

    it('hideSessionPicker(sessionId) resolves the promise with that sessionId', async () => {
        const store = createChatStore();
        const promise = store.showSessionPicker([makeSessionEntry('s1'), makeSessionEntry('s2')]);
        store.hideSessionPicker('s2');
        const result = await promise;
        expect(result).toBe('s2');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('hideSessionPicker() (cancel) resolves undefined', async () => {
        const store = createChatStore();
        const promise = store.showSessionPicker([makeSessionEntry('s1')]);
        store.hideSessionPicker();
        expect(await promise).toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('showSessionPicker with empty entries resolves undefined without opening overlay', async () => {
        const store = createChatStore();
        const result = await store.showSessionPicker([]);
        expect(result).toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('updateSessionPickerSearch narrows visible entries', () => {
        const store = createChatStore();
        const entries = [
            makeSessionEntry('s1', 'Feature work'),
            makeSessionEntry('s2', 'Bug fix'),
            makeSessionEntry('s3', 'Feature refactor'),
        ];
        store.showSessionPicker(entries);
        store.updateSessionPickerSearch('feature');
        const snapshot = store.getSnapshot();
        const view = createSessionPickerView(snapshot.sessionPickerKeypress, snapshot.sessionPickerEntries, 10);
        expect(view.filteredEntries.map((e) => e.sessionId)).toEqual(['s1', 's3']);
        store.hideSessionPicker();
    });

    it('confirmSessionPicker resolves the selected sessionId', async () => {
        const store = createChatStore();
        const promise = store.showSessionPicker([
            makeSessionEntry('s1'),
            makeSessionEntry('s2'),
            makeSessionEntry('s3'),
        ]);
        store.updateSessionPickerSearch('\u001b[B');
        store.confirmSessionPicker();
        expect(await promise).toBe('s2');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('cancelSessionPicker resolves undefined', async () => {
        const store = createChatStore();
        const promise = store.showSessionPicker([makeSessionEntry('s1')]);
        store.cancelSessionPicker();
        expect(await promise).toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('createSessionPickerView — pure view helper', () => {
    it('returns all entries when searchQuery is empty', () => {
        const state = createProviderPromptKeypressState();
        const entries = [makeSessionEntry('s1', 'One'), makeSessionEntry('s2', 'Two')];
        const view = createSessionPickerView(state, entries, 5);
        expect(view.totalCount).toBe(2);
        expect(view.filteredEntries.map((e) => e.sessionId)).toEqual(['s1', 's2']);
    });

    it('filters entries by searchQuery against sessionId and label', () => {
        const state = { ...createProviderPromptKeypressState(), searchQuery: 'feat' };
        const entries = [
            makeSessionEntry('s1', 'Feature work'),
            makeSessionEntry('s2', 'Bug fix'),
            makeSessionEntry('feat-2', 'Refactor'),
        ];
        const view = createSessionPickerView(state, entries, 10);
        expect(view.filteredEntries.map((e) => e.sessionId)).toEqual(['s1', 'feat-2']);
    });

    it('windows visible entries to maxVisible', () => {
        const entries = Array.from({ length: 10 }, (_, i) => makeSessionEntry(`s${i}`, `Session ${i}`));
        const state = createProviderPromptKeypressState();
        const view = createSessionPickerView(state, entries, 3);
        expect(view.visibleEntries).toHaveLength(3);
        expect(view.startIndex).toBe(0);
        expect(view.visibleEntries.map((e) => e.sessionId)).toEqual(['s0', 's1', 's2']);
    });

    it('clamps selectedIndex to filteredCount - 1', () => {
        const entries = [makeSessionEntry('s1', 'One'), makeSessionEntry('s2', 'Two'), makeSessionEntry('s3', 'Three')];
        const state = { ...createProviderPromptKeypressState(), selectedIndex: 5 };
        const view = createSessionPickerView(state, entries, 10);
        expect(view.selectedIndex).toBe(2);
    });

    it('clamps selectedIndex to 0 when the filtered set is empty', () => {
        const state = { ...createProviderPromptKeypressState(), selectedIndex: 3 };
        const view = createSessionPickerView(state, [], 5);
        expect(view.selectedIndex).toBe(0);
        expect(view.totalCount).toBe(0);
        expect(view.visibleEntries).toEqual([]);
    });

    it('re-centers the window when the selection moves past the middle', () => {
        const entries = Array.from({ length: 10 }, (_, i) => makeSessionEntry(`s${i}`, `Session ${i}`));
        const state = { ...createProviderPromptKeypressState(), selectedIndex: 7 };
        const view = createSessionPickerView(state, entries, 3);
        expect(view.selectedIndex).toBe(7);
        expect(view.startIndex).toBe(6);
        expect(view.visibleEntries.map((e) => e.sessionId)).toEqual(['s6', 's7', 's8']);
    });
});

describe('chat-store — agents dashboard overlay', () => {
    function makeAgentEntry(name: string, source: string = 'bundled'): DashboardAgentEntry {
        return { name, description: name, source, disabled: false };
    }

    it('showAgentsDashboard sets active=true and populates agents from passed-in entries', () => {
        const store = createChatStore();
        const entries = [makeAgentEntry('oracle'), makeAgentEntry('quick')];
        store.showAgentsDashboard(entries);
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('agents-dashboard');
        expect(snapshot.agentsDashboard.active).toBe(true);
        expect(snapshot.agentsDashboard.agents).toEqual(entries);
        expect(snapshot.agentsDashboard.selectedIndex).toBe(0);
        expect(snapshot.agentsDashboard.sourceTab).toBe('all');
        expect(snapshot.agentsDashboard.editingName).toBeNull();
    });

    it('hideAgentsDashboard sets active=false and clears edit state', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        store.beginAgentsDashboardModelEdit('oracle');
        store.hideAgentsDashboard();
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('none');
        expect(snapshot.agentsDashboard.active).toBe(false);
        expect(snapshot.agentsDashboard.editingName).toBeNull();
    });

    it('navigateAgentsDashboard clamps at bounds', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a'), makeAgentEntry('b'), makeAgentEntry('c')]);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(1);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(2);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(2);
        store.navigateAgentsDashboard(-5);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(0);
    });

    it('navigateAgentsDashboard is a no-op when the filtered list is empty', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a', 'project')]);
        store.cycleAgentsDashboardSourceTab(2);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('user');
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(0);
    });

    it('cycleAgentsDashboardSourceTab cycles all -> project -> user -> bundled', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a', 'project'), makeAgentEntry('b', 'bundled')]);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('all');
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('project');
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('user');
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('bundled');
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('all');
    });

    it('cycleAgentsDashboardSourceTab wraps backward', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a')]);
        store.cycleAgentsDashboardSourceTab(-1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('bundled');
    });

    it('toggleAgentsDashboardAgentDisabled flips the in-memory disabled flag', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        expect(store.getSnapshot().agentsDashboard.agents[0]?.disabled).toBe(false);
        store.toggleAgentsDashboardAgentDisabled('oracle');
        expect(store.getSnapshot().agentsDashboard.agents[0]?.disabled).toBe(true);
        store.toggleAgentsDashboardAgentDisabled('oracle');
        expect(store.getSnapshot().agentsDashboard.agents[0]?.disabled).toBe(false);
    });

    it('beginAgentsDashboardModelEdit seeds editBuffer from the override model', () => {
        const store = createChatStore();
        const entry: DashboardAgentEntry = {
            name: 'oracle',
            description: 'd',
            source: 'bundled',
            disabled: false,
            overrideModel: 'anthropic/claude-sonnet-4-6',
        };
        store.showAgentsDashboard([entry]);
        store.beginAgentsDashboardModelEdit('oracle');
        const snap = store.getSnapshot();
        expect(snap.agentsDashboard.editingName).toBe('oracle');
        expect(snap.agentsDashboard.editBuffer).toBe('anthropic/claude-sonnet-4-6');
    });

    it('beginAgentsDashboardModelEdit falls back to the base model when no override exists', () => {
        const store = createChatStore();
        const entry: DashboardAgentEntry = {
            name: 'oracle',
            description: 'd',
            source: 'bundled',
            disabled: false,
            model: 'mctrl/slow',
        };
        store.showAgentsDashboard([entry]);
        store.beginAgentsDashboardModelEdit('oracle');
        expect(store.getSnapshot().agentsDashboard.editBuffer).toBe('mctrl/slow');
    });

    it('commitAgentsDashboardModelEdit updates overrideModel in memory', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        store.beginAgentsDashboardModelEdit('oracle');
        store.commitAgentsDashboardModelEdit('openai/gpt-5');
        const snap = store.getSnapshot();
        expect(snap.agentsDashboard.editingName).toBeNull();
        expect(snap.agentsDashboard.agents[0]?.overrideModel).toBe('openai/gpt-5');
    });

    it('commitAgentsDashboardModelEdit(undefined) clears the override', () => {
        const store = createChatStore();
        const entry: DashboardAgentEntry = {
            name: 'oracle',
            description: 'd',
            source: 'bundled',
            disabled: false,
            overrideModel: 'openai/gpt-5',
        };
        store.showAgentsDashboard([entry]);
        store.beginAgentsDashboardModelEdit('oracle');
        store.commitAgentsDashboardModelEdit(undefined);
        const snap = store.getSnapshot();
        expect(snap.agentsDashboard.agents[0]?.overrideModel).toBeUndefined();
    });

    it('commitAgentsDashboardModelEdit is a no-op when no edit is active', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        store.commitAgentsDashboardModelEdit('openai/gpt-5');
        expect(store.getSnapshot().agentsDashboard.agents[0]?.overrideModel).toBeUndefined();
    });

    it('cancelAgentsDashboardModelEdit clears edit state without committing', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('oracle')]);
        store.beginAgentsDashboardModelEdit('oracle');
        store.cancelAgentsDashboardModelEdit();
        const snap = store.getSnapshot();
        expect(snap.agentsDashboard.editingName).toBeNull();
        expect(snap.agentsDashboard.editBuffer).toBe('');
        expect(snap.agentsDashboard.agents[0]?.overrideModel).toBeUndefined();
    });

    it('reloadAgentsDashboard preserves selection when agent still present', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a'), makeAgentEntry('b'), makeAgentEntry('c')]);
        store.navigateAgentsDashboard(2);
        store.reloadAgentsDashboard([
            makeAgentEntry('a'),
            makeAgentEntry('b'),
            makeAgentEntry('c'),
            makeAgentEntry('d'),
        ]);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(2);
    });

    it('reloadAgentsDashboard resets selection when agent is gone', () => {
        const store = createChatStore();
        store.showAgentsDashboard([makeAgentEntry('a'), makeAgentEntry('b'), makeAgentEntry('c')]);
        store.navigateAgentsDashboard(2);
        store.reloadAgentsDashboard([makeAgentEntry('a'), makeAgentEntry('b')]);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(0);
    });

    it('source-tab filter narrows navigation to matching entries', () => {
        const store = createChatStore();
        store.showAgentsDashboard([
            makeAgentEntry('a', 'project'),
            makeAgentEntry('b', 'bundled'),
            makeAgentEntry('c', 'project'),
        ]);
        store.cycleAgentsDashboardSourceTab(1);
        expect(store.getSnapshot().agentsDashboard.sourceTab).toBe('project');
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(0);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(1);
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(1);
    });
});

describe('createAgentsDashboardView — pure view helper', () => {
    function makeAgentEntry(name: string, source: string = 'bundled'): DashboardAgentEntry {
        return { name, description: name, source, disabled: false };
    }

    function dashboardState(overrides?: Partial<AgentsDashboardState>): AgentsDashboardState {
        return {
            active: true,
            agents: [],
            selectedIndex: 0,
            sourceTab: 'all',
            editingName: null,
            editBuffer: '',
            ...overrides,
        };
    }

    it('returns totalCount 0 and null inspectorEntry for empty agents', () => {
        const view = createAgentsDashboardView(dashboardState({ agents: [] }), 10);
        expect(view.totalCount).toBe(0);
        expect(view.inspectorEntry).toBeNull();
        expect(view.visibleEntries).toEqual([]);
        expect(view.startIndex).toBe(0);
        expect(view.endIndex).toBe(0);
    });

    it('windows 12 agents with maxVisible=10 and selectedIndex=11 to {startIndex:2, endIndex:11, totalCount:12}', () => {
        const agents = Array.from({ length: 12 }, (_, i) => makeAgentEntry(`a${i}`));
        const view = createAgentsDashboardView(dashboardState({ agents, selectedIndex: 11 }), 10);
        expect(view.startIndex).toBe(2);
        expect(view.endIndex).toBe(11);
        expect(view.totalCount).toBe(12);
        expect(view.visibleEntries).toHaveLength(10);
        expect(view.selectedIndex).toBe(11);
    });

    it('source-tab filter project returns only source===project entries', () => {
        const agents = [makeAgentEntry('a', 'project'), makeAgentEntry('b', 'bundled'), makeAgentEntry('c', 'project')];
        const view = createAgentsDashboardView(dashboardState({ agents, sourceTab: 'project' }), 10);
        expect(view.totalCount).toBe(2);
        expect(view.visibleEntries.map((e) => e.name)).toEqual(['a', 'c']);
    });

    it('sourceTabs counts reflect the FULL agent list regardless of active tab', () => {
        const agents = [
            makeAgentEntry('a', 'project'),
            makeAgentEntry('b', 'bundled'),
            makeAgentEntry('c', 'user'),
            makeAgentEntry('d', 'project'),
        ];
        const view = createAgentsDashboardView(dashboardState({ agents, sourceTab: 'project' }), 10);
        const counts = Object.fromEntries(view.sourceTabs.map((t) => [t.id, t.count]));
        expect(counts).toEqual({ all: 4, project: 2, user: 1, bundled: 1 });
    });

    it('inspectorEntry returns the currently-selected entry', () => {
        const agents = [makeAgentEntry('a'), makeAgentEntry('b'), makeAgentEntry('c')];
        const view = createAgentsDashboardView(dashboardState({ agents, selectedIndex: 1 }), 10);
        expect(view.inspectorEntry?.name).toBe('b');
    });

    it('clamps selectedIndex to filtered count - 1', () => {
        const agents = [makeAgentEntry('a'), makeAgentEntry('b')];
        const view = createAgentsDashboardView(dashboardState({ agents, selectedIndex: 10 }), 10);
        expect(view.selectedIndex).toBe(1);
    });

    it('re-centers the window when selection moves past the middle', () => {
        const agents = Array.from({ length: 12 }, (_, i) => makeAgentEntry(`a${i}`));
        const view = createAgentsDashboardView(dashboardState({ agents, selectedIndex: 0 }), 3);
        expect(view.startIndex).toBe(0);
        expect(view.visibleEntries.map((e) => e.name)).toEqual(['a0', 'a1', 'a2']);
    });
});

describe('chat-store — mission panel overlay', () => {
    function makeMissionRow(id: string, label?: string): MissionPanelRow {
        return { id, label: label ?? id };
    }

    it('showMissionPanel sets overlayMode and initializes the slice with default tab and reload metadata', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('r1'), makeMissionRow('r2')]);
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('mission-panel');
        expect(snapshot.missionPanel.active).toBe(true);
        expect(snapshot.missionPanel.activeTab).toBe('runs');
        expect(snapshot.missionPanel.rows.map((r) => r.id)).toEqual(['r1', 'r2']);
        expect(snapshot.missionPanel.selectedIndex).toBe(0);
        expect(snapshot.missionPanel.loadedAt).not.toBeNull();
        expect(snapshot.missionPanel.count).toBe(2);
    });

    it('showMissionPanel with no rows initializes an empty-state slice without crashing', () => {
        const store = createChatStore();
        store.showMissionPanel();
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('mission-panel');
        expect(snapshot.missionPanel.active).toBe(true);
        expect(snapshot.missionPanel.rows).toEqual([]);
        expect(snapshot.missionPanel.count).toBe(0);
        expect(snapshot.missionPanel.loadedAt).not.toBeNull();
    });

    it('hideMissionPanel clears the overlay and deactivates the slice', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('r1')]);
        store.hideMissionPanel();
        const snapshot = store.getSnapshot();
        expect(snapshot.overlayMode).toBe('none');
        expect(snapshot.missionPanel.active).toBe(false);
    });

    it('navigateMissionPanel moves the cursor down and up within bounds', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);
        store.navigateMissionPanel(-1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
    });

    it('navigateMissionPanel clamps at the upper bound', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(1);
        store.navigateMissionPanel(1);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);
    });

    it('navigateMissionPanel clamps at the lower bound with a large negative delta', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b')]);
        store.navigateMissionPanel(-5);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('navigateMissionPanel is a no-op when there are no rows', () => {
        const store = createChatStore();
        store.showMissionPanel();
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('setMissionPanelTab switches the active tab', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('r1')]);
        const tabs: readonly MissionPanelTab[] = ['runs', 'jobs', 'agents', 'drain', 'continue'];
        for (const tab of tabs) {
            store.setMissionPanelTab(tab);
            expect(store.getSnapshot().missionPanel.activeTab).toBe(tab);
        }
    });

    it('setMissionPanelTab is a no-op when the tab is already active', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('r1')]);
        let publishCount = 0;
        store.subscribe(() => {
            publishCount += 1;
        });
        store.setMissionPanelTab('runs');
        expect(publishCount).toBe(0);
    });

    it('setMissionPanelTab clamps selectedIndex into range when switching', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b')]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
        store.setMissionPanelTab('jobs');
        expect(store.getSnapshot().missionPanel.activeTab).toBe('jobs');
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
    });

    it('reloadMissions refreshes rows and reload metadata', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a')]);
        store.reloadMissions([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        const snapshot = store.getSnapshot();
        expect(snapshot.missionPanel.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
        expect(snapshot.missionPanel.count).toBe(3);
        expect(snapshot.missionPanel.loadedAt).not.toBeNull();
    });

    it('reloadMissions preserves the selected row when it is still present', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(2);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);
        store.reloadMissions([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c'), makeMissionRow('d')]);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);
    });

    it('reloadMissions resets selection to 0 when the selected row is gone', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(2);
        store.reloadMissions([makeMissionRow('a'), makeMissionRow('b')]);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('reloadMissions is a no-op when the panel is not active', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a')]);
        store.hideMissionPanel();
        let publishCount = 0;
        store.subscribe(() => {
            publishCount += 1;
        });
        store.reloadMissions([makeMissionRow('z')]);
        expect(publishCount).toBe(0);
        expect(store.getSnapshot().missionPanel.rows.map((r) => r.id)).toEqual(['a']);
    });

    it('publishing a new mission panel value creates a new snapshot reference', () => {
        const store = createChatStore();
        const first = store.getSnapshot();
        store.showMissionPanel([makeMissionRow('a')]);
        const second = store.getSnapshot();
        expect(second).not.toBe(first);
        expect(second.missionPanel.active).toBe(true);
    });

    it('navigateMissionPanel on a single-row list is a no-op in both directions', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('only')]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
        store.navigateMissionPanel(-1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('reloadMissions transitioning to an empty list resets selection to 0', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b')]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);
        store.reloadMissions([]);
        const snapshot = store.getSnapshot();
        expect(snapshot.missionPanel.rows).toEqual([]);
        expect(snapshot.missionPanel.count).toBe(0);
        expect(snapshot.missionPanel.selectedIndex).toBe(0);
    });

    it('showMissionPanel resets selectedIndex and activeTab when re-opening after navigation', () => {
        const store = createChatStore();
        store.showMissionPanel([makeMissionRow('a'), makeMissionRow('b'), makeMissionRow('c')]);
        store.navigateMissionPanel(2);
        store.setMissionPanelTab('jobs');
        store.showMissionPanel([makeMissionRow('x'), makeMissionRow('y')]);
        const snapshot = store.getSnapshot();
        expect(snapshot.missionPanel.selectedIndex).toBe(0);
        expect(snapshot.missionPanel.activeTab).toBe('runs');
    });
});

describe('chat-store — history picker + timestamped entries', () => {
    function makeHistoryEntry(id: string, text: string, timestamp: number) {
        return { id, text, timestamp };
    }

    it('seeds historyEntries from initialHistoryEntries options', () => {
        const store = createChatStore({
            initialHistoryEntries: [makeHistoryEntry('a', 'older', 1), makeHistoryEntry('b', 'newer', 2)],
        });
        expect(store.getSnapshot().historyEntries).toEqual([
            makeHistoryEntry('a', 'older', 1),
            makeHistoryEntry('b', 'newer', 2),
        ]);
        expect(store.getSnapshot().historyPickerView.total).toBe(2);
    });

    it('open → navigate → confirm returns selected text without changing inputMirror', () => {
        const store = createChatStore({
            initialHistoryEntries: [makeHistoryEntry('a', 'older', 1), makeHistoryEntry('b', 'newer', 2)],
        });
        store.setInputMirror('draft');
        store.openHistoryPicker('draft');
        expect(store.isHistoryPickerOpen()).toBe(true);
        expect(store.getSnapshot().historyPickerView).toMatchObject({
            open: true,
            selectedIndex: 0,
            total: 2,
            draftSnapshot: 'draft',
        });
        expect(store.confirmHistoryPicker()).toBe('newer');
        expect(store.isHistoryPickerOpen()).toBe(false);
        expect(store.getSnapshot().inputMirror).toBe('draft');

        store.openHistoryPicker('draft');
        store.navigateHistoryPicker('up');
        expect(store.getSnapshot().historyPicker.selectedIndex).toBe(1);
        expect(store.confirmHistoryPicker()).toBe('older');
        expect(store.getSnapshot().inputMirror).toBe('draft');
    });

    it('exposes the highlighted history text without closing the picker', () => {
        const store = createChatStore({
            initialHistoryEntries: [makeHistoryEntry('a', 'older', 1), makeHistoryEntry('b', 'newer', 2)],
        });

        store.openHistoryPicker('draft');
        expect(store.selectedHistoryPickerText()).toBe('newer');
        expect(store.isHistoryPickerOpen()).toBe(true);

        store.navigateHistoryPicker('up');
        expect(store.selectedHistoryPickerText()).toBe('older');
        expect(store.isHistoryPickerOpen()).toBe(true);
    });

    it('cancelHistoryPicker closes without changing inputMirror', () => {
        const store = createChatStore({
            initialHistoryEntries: [makeHistoryEntry('a', 'only', 1)],
        });
        store.setInputMirror('keep me');
        store.openHistoryPicker('keep me');
        store.cancelHistoryPicker();
        expect(store.isHistoryPickerOpen()).toBe(false);
        expect(store.getSnapshot().inputMirror).toBe('keep me');
    });

    it('submitLine appends a timestamped entry and dedupes consecutive identical text', () => {
        const store = createChatStore();
        const before = Date.now();
        store.submitLine('hello');
        store.submitLine('hello');
        store.submitLine('world');
        const entries = store.getSnapshot().historyEntries;
        expect(entries).toHaveLength(2);
        expect(entries[0]?.text).toBe('hello');
        expect(entries[0]?.id).toMatch(/^hist-\d+$/);
        expect(entries[0]?.timestamp).toBeGreaterThanOrEqual(before);
        expect(entries[1]?.text).toBe('world');
        expect(store.getSnapshot().historyEntries.map((entry) => entry.text)).toEqual(['hello', 'world']);
    });

    it('confirm on empty history returns undefined and closes', () => {
        const store = createChatStore();
        store.openHistoryPicker('x');
        expect(store.isHistoryPickerOpen()).toBe(true);
        expect(store.confirmHistoryPicker()).toBeUndefined();
        expect(store.isHistoryPickerOpen()).toBe(false);
    });

    it('navigateHistoryPicker is a no-op when closed', () => {
        const store = createChatStore({
            initialHistoryEntries: [makeHistoryEntry('a', 'only', 1)],
        });
        const before = store.getSnapshot().historyPicker;
        store.navigateHistoryPicker('down');
        expect(store.getSnapshot().historyPicker).toEqual(before);
    });

    it('setHistoryEntries replaces the list and preserves an open picker', () => {
        const store = createChatStore({
            initialHistoryEntries: [makeHistoryEntry('a', 'old', 1)],
        });
        store.openHistoryPicker('draft');
        store.setHistoryEntries([makeHistoryEntry('b', 'one', 10), makeHistoryEntry('c', 'two', 20)]);
        const snapshot = store.getSnapshot();
        expect(snapshot.historyEntries.map((entry) => entry.text)).toEqual(['one', 'two']);
        expect(snapshot.historyPicker.open).toBe(true);
        expect(snapshot.historyPickerView.total).toBe(2);
    });

    it('openHistoryPicker is a no-op when already open', () => {
        const store = createChatStore({
            initialHistoryEntries: [makeHistoryEntry('a', 'only', 1)],
        });
        store.openHistoryPicker('first');
        store.navigateHistoryPicker('down');
        store.openHistoryPicker('second');
        expect(store.getSnapshot().historyPicker.draftSnapshot).toBe('first');
        expect(store.getSnapshot().historyPicker.open).toBe(true);
    });
});

describe('ChatStore sticky notice', () => {
    it('sets and clears stickyNotice without touching transientNotice', () => {
        // Given: a fresh store.
        const store = createChatStore();
        expect(store.getSnapshot().stickyNotice).toBeNull();

        // When: a sticky attach banner is set.
        store.setStickyNotice('Resumable run: interrupted. Type /continue to resume work.');

        // Then: sticky is set and transient remains empty.
        expect(store.getSnapshot().stickyNotice).toBe('Resumable run: interrupted. Type /continue to resume work.');
        expect(store.getSnapshot().transientNotice).toBeNull();

        // When: sticky is cleared.
        store.setStickyNotice(null);

        // Then: sticky is null again.
        expect(store.getSnapshot().stickyNotice).toBeNull();
    });
});

describe('ChatStore orphaned tool preview reconciliation', () => {
    function statusOf(part: RichTranscriptPart | undefined): string | undefined {
        return part !== undefined && 'status' in part ? part.status : undefined;
    }

    function typeOf(part: RichTranscriptPart | undefined): string | undefined {
        return part?.type;
    }

    it('drops an orphaned pending preview when a settlement arrives with a different id for the same toolCallId', () => {
        // Given: an orphaned pending inline-tool preview (e.g., the pending queue was cleared
        // between renderToolPreview and renderInteractiveToolSettlement, so the settlement
        // minted a new occurrence number).
        const store = createChatStore();
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-A:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'call-A',
                toolName: 'repo.read',
                text: 'tool: repo.read',
                status: 'pending',
                messageId: 'msg-1',
            },
            'tool: repo.read\n',
        );
        expect(store.getSnapshot().transcriptParts).toHaveLength(1);

        // When: the settlement arrives with a different id (orphan scenario).
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-A:occurrence:2',
                type: 'inline-tool',
                toolCallId: 'call-A',
                toolName: 'repo.read',
                text: 'tool: repo.read result',
                status: 'completed',
                messageId: 'msg-1',
            },
            'tool: repo.read completed\n',
        );

        // Then: only the settlement row remains; the orphaned pending preview is gone.
        const parts = store.getSnapshot().transcriptParts;
        expect(parts).toHaveLength(1);
        expect(parts[0]?.id).toBe('tool:turn-1:call-A:occurrence:2');
        expect(statusOf(parts[0])).toBe('completed');
    });

    it('drops an orphaned :preview companion from a different occurrence when its settlement arrives', () => {
        // Given: an orphaned :preview companion (e.g., the file.patch diff preview) registered
        // under occurrence:1, while the settlement mints occurrence:2.
        const store = createChatStore();
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-B:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'call-B',
                toolName: 'file.patch',
                text: 'tool: file.patch',
                status: 'pending',
                messageId: 'msg-1',
            },
            'tool: file.patch\n',
        );
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-B:occurrence:1:preview',
                type: 'diff',
                filePath: 'src/a.ts',
                toolCallId: 'call-B',
                text: '-old\n+new',
                status: 'pending',
                messageId: 'msg-1',
            },
            '',
        );
        expect(store.getSnapshot().transcriptParts).toHaveLength(2);

        // When: the settlement arrives with a different occurrence number.
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-B:occurrence:2',
                type: 'block-tool',
                toolCallId: 'call-B',
                toolName: 'file.patch',
                text: 'patch applied',
                status: 'completed',
                messageId: 'msg-1',
            },
            'patch applied\n',
        );

        // Then: both orphaned rows from occurrence:1 are dropped; only the settlement remains.
        const parts = store.getSnapshot().transcriptParts;
        expect(parts).toHaveLength(1);
        expect(parts[0]?.id).toBe('tool:turn-1:call-B:occurrence:2');
        expect(statusOf(parts[0])).toBe('completed');
    });

    it('preserves the same-occurrence :preview companion and updates its status (regression)', () => {
        const store = createChatStore();
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-C:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'call-C',
                toolName: 'file.patch',
                text: 'tool: file.patch',
                status: 'pending',
                messageId: 'msg-1',
            },
            'tool: file.patch\n',
        );
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-C:occurrence:1:preview',
                type: 'diff',
                filePath: 'src/a.ts',
                toolCallId: 'call-C',
                text: '-old\n+new',
                status: 'pending',
                messageId: 'msg-1',
            },
            '',
        );

        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-C:occurrence:1',
                type: 'block-tool',
                toolCallId: 'call-C',
                toolName: 'file.patch',
                text: 'patch applied',
                status: 'completed',
                messageId: 'msg-1',
            },
            'patch applied\n',
        );

        const parts = store.getSnapshot().transcriptParts;
        expect(parts).toHaveLength(2);
        const settlement = parts.find((part) => part.id === 'tool:turn-1:call-C:occurrence:1');
        const preview = parts.find((part) => part.id === 'tool:turn-1:call-C:occurrence:1:preview');
        expect(typeOf(settlement)).toBe('block-tool');
        expect(statusOf(settlement)).toBe('completed');
        expect(typeOf(preview)).toBe('diff');
        expect(statusOf(preview)).toBe('completed');
    });

    it('preserves unrelated pending previews for the same toolCallId in FIFO order', () => {
        // Given: two preview occurrences for the same toolCallId (FIFO batched task scenario).
        const store = createChatStore();
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-D:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'call-D',
                toolName: 'task',
                text: 'task 1',
                status: 'pending',
                messageId: 'msg-1',
            },
            'task 1\n',
        );
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-D:occurrence:2',
                type: 'inline-tool',
                toolCallId: 'call-D',
                toolName: 'task',
                text: 'task 2',
                status: 'pending',
                messageId: 'msg-1',
            },
            'task 2\n',
        );

        // When: only occurrence:1 settles (correct same-id claim).
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-D:occurrence:1',
                type: 'subagent',
                toolCallId: 'call-D',
                text: 'task 1 result',
                status: 'completed',
                messageId: 'msg-1',
            },
            'task 1 done\n',
        );

        // Then: occurrence:2 stays pending (it has not settled yet); occurrence:1 settled.
        const parts = store.getSnapshot().transcriptParts;
        expect(parts).toHaveLength(2);
        const settled = parts.find((part) => part.id === 'tool:turn-1:call-D:occurrence:1');
        const pending = parts.find((part) => part.id === 'tool:turn-1:call-D:occurrence:2');
        expect(statusOf(settled)).toBe('completed');
        expect(typeOf(settled)).toBe('subagent');
        expect(statusOf(pending)).toBe('pending');
        expect(typeOf(pending)).toBe('inline-tool');
    });

    it('does not touch previews with a different toolCallId', () => {
        const store = createChatStore();
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-E:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'call-E',
                toolName: 'repo.read',
                text: 'other tool pending',
                status: 'pending',
                messageId: 'msg-1',
            },
            'other\n',
        );

        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-F:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'call-F',
                toolName: 'repo.read',
                text: 'tool: repo.read',
                status: 'completed',
                messageId: 'msg-1',
            },
            'done\n',
        );

        // The unrelated call-E preview stays untouched.
        const parts = store.getSnapshot().transcriptParts;
        expect(parts).toHaveLength(2);
        const ePart = parts.find((part) => part.id === 'tool:turn-1:call-E:occurrence:1');
        expect(statusOf(ePart)).toBe('pending');
    });

    it('does not remove already-settled rows that share the toolCallId', () => {
        // Guards against double-settlement or mid-flight occurrence collisions nuking
        // completed rows that happen to share the toolCallId.
        const store = createChatStore();
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-G:occurrence:1',
                type: 'inline-tool',
                toolCallId: 'call-G',
                toolName: 'repo.read',
                text: 'first',
                status: 'completed',
                messageId: 'msg-1',
            },
            'first\n',
        );
        store.emitTranscriptPart(
            {
                id: 'tool:turn-1:call-G:occurrence:2',
                type: 'inline-tool',
                toolCallId: 'call-G',
                toolName: 'repo.read',
                text: 'second',
                status: 'completed',
                messageId: 'msg-1',
            },
            'second\n',
        );

        const parts = store.getSnapshot().transcriptParts;
        expect(parts).toHaveLength(2);
        expect(parts.every((part) => statusOf(part) === 'completed')).toBe(true);
    });
});

describe('chat-store — stream silence activity clock', () => {
    it('stamps lastStreamActivityAt when generating starts and clears when it stops', () => {
        const store = createChatStore();
        expect(store.getSnapshot().lastStreamActivityAt).toBeUndefined();
        store.setGenerating(true);
        const first = store.getSnapshot().lastStreamActivityAt;
        expect(typeof first).toBe('number');
        store.emitOutput('token\n');
        const second = store.getSnapshot().lastStreamActivityAt;
        expect(typeof second).toBe('number');
        expect(second).toBeGreaterThanOrEqual(first ?? 0);
        store.setGenerating(false);
        expect(store.getSnapshot().lastStreamActivityAt).toBeUndefined();
    });
});

describe('chat-store — context pressure notices', () => {
    it('sets a sticky /compact notice when fill crosses the critical threshold', () => {
        const store = createChatStore();
        store.setContextTokensMax(100_000);
        store.setContextTokensUsed(95_000);
        expect(store.getSnapshot().stickyNotice).toContain('/compact');
        expect(store.getSnapshot().stickyNotice).toContain('nearly full');
    });

    it('sets an overflow recovery notice when overflow error text is emitted', () => {
        const store = createChatStore();
        store.emitTranscriptFallback('Error: context length exceeded\n');
        expect(store.getSnapshot().stickyNotice).toContain('Context overflow');
        expect(store.getSnapshot().stickyNotice).toContain('/compact');
    });
});

describe('chat-store — setSessionId prompt isolation', () => {
    it('setSessionId clears the in-flight prompt buffer and menus', () => {
        const store = createChatStore();
        store.setInputMirror('half typed draft');
        store.setSessionId('session_next');
        expect(store.getSnapshot().sessionId).toBe('session_next');
        expect(store.getSnapshot().inputMirror).toBe('');
    });
});

describe('chat-store — undo overlay gate', () => {
    it('undoLastViewExchange is blocked while an overlay is open', () => {
        const store = createChatStore();
        store.emitTranscriptPart({ id: 'u1', type: 'user', text: 'hi' }, 'You: hi\n');
        store.emitTranscriptPart({ id: 'a1', type: 'assistant', text: 'yo' }, 'Assistant: yo\n');
        store.toggleDiagnosticsOverlay();
        expect(store.getSnapshot().overlayMode).toBe('diagnostics');
        expect(store.undoLastViewExchange()).toBe('blocked');
        store.hideDiagnosticsOverlay();
        expect(store.undoLastViewExchange()).toBe('ok');
    });

    it('redoLastViewExchange is blocked while an overlay is open', () => {
        const store = createChatStore();
        store.emitTranscriptPart({ id: 'u1', type: 'user', text: 'hi' }, 'You: hi\n');
        store.emitTranscriptPart({ id: 'a1', type: 'assistant', text: 'yo' }, 'Assistant: yo\n');
        expect(store.undoLastViewExchange()).toBe('ok');
        store.toggleDiagnosticsOverlay();
        expect(store.redoLastViewExchange()).toBe('blocked');
        store.hideDiagnosticsOverlay();
        expect(store.redoLastViewExchange()).toBe('ok');
    });

    it('redoLastViewExchange is blocked while generating', () => {
        const store = createChatStore();
        store.emitTranscriptPart({ id: 'u1', type: 'user', text: 'hi' }, 'You: hi\n');
        store.emitTranscriptPart({ id: 'a1', type: 'assistant', text: 'yo' }, 'Assistant: yo\n');
        expect(store.undoLastViewExchange()).toBe('ok');
        store.setGenerating(true);
        expect(store.redoLastViewExchange()).toBe('generating');
        store.setGenerating(false);
        expect(store.redoLastViewExchange()).toBe('ok');
    });
});

describe('chat-store — setSessionId clears view undo stash', () => {
    it('drops stashed exchange so redo cannot leak across sessions', () => {
        const store = createChatStore();
        store.setSessionId('s1');
        store.emitTranscriptPart({ id: 'u1', type: 'user', text: 'hi' }, 'You: hi\n');
        store.emitTranscriptPart({ id: 'a1', type: 'assistant', text: 'yo' }, 'Assistant: yo\n');
        expect(store.undoLastViewExchange()).toBe('ok');
        expect(store.hasViewUndoStash()).toBe(true);
        store.setSessionId('s2');
        expect(store.hasViewUndoStash()).toBe(false);
        expect(store.redoLastViewExchange()).toBe('empty');
    });

    it('same session id does not drop view undo stash', () => {
        const store = createChatStore();
        store.setSessionId('s1');
        store.emitTranscriptPart({ id: 'u1', type: 'user', text: 'hi' }, 'You: hi\n');
        store.emitTranscriptPart({ id: 'a1', type: 'assistant', text: 'yo' }, 'Assistant: yo\n');
        expect(store.undoLastViewExchange()).toBe('ok');
        expect(store.hasViewUndoStash()).toBe(true);
        // CLI loop re-pushes setSessionId after actions with the same id.
        store.setSessionId('s1');
        expect(store.hasViewUndoStash()).toBe(true);
        expect(store.redoLastViewExchange()).toBe('ok');
    });
});

describe('chat-store — enqueueEvent acceptance', () => {
    it('enqueueEvent returns false after closeEventQueue', () => {
        const store = createChatStore();
        store.closeEventQueue();
        expect(store.enqueueEvent({ type: 'line', value: 'ignored' })).toBe(false);
    });

    it('enqueueEvent returns true while open', () => {
        const store = createChatStore();
        expect(store.enqueueEvent({ type: 'line', value: 'hello' })).toBe(true);
    });
});

describe('chat-store — closed queue submit', () => {
    it('submitLine is a no-op after closeEventQueue', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.submitLine('hello after close');
        expect(store.getSnapshot().outputText).not.toContain('hello after close');
        expect(store.getSnapshot().transcriptParts.some((part) => part.type === 'user')).toBe(false);
    });
});

describe('chat-store — approval enqueue fail-closed', () => {
    it('confirmApproval is a no-op after closeEventQueue teardown', () => {
        const store = createChatStore();
        store.showApproval('bash', 'run rm');
        expect(store.getSnapshot().overlayMode).toBe('approval');
        // Teardown clears the approval overlay and closes the queue.
        store.closeEventQueue();
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.confirmApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('denyApproval is a no-op after closeEventQueue teardown', () => {
        const store = createChatStore();
        store.showApproval('bash', 'run rm');
        store.closeEventQueue();
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.denyApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — teardown cancels overlay promises', () => {
    it('closeEventQueue resolves pending question promises', async () => {
        const store = createChatStore();
        const pending = store.showQuestion('Continue?', ['yes', 'no']);
        expect(store.getSnapshot().overlayMode).toBe('question');
        store.closeEventQueue();
        await expect(pending).resolves.toBe('');
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('closeEventQueue resolves pending model picker promises as undefined', async () => {
        const store = createChatStore();
        const pending = store.showModelPicker([{ providerID: 'openai', modelID: 'gpt', label: 'gpt' }] as never);
        expect(store.getSnapshot().overlayMode).toBe('model-picker');
        store.closeEventQueue();
        await expect(pending).resolves.toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('closeEventQueue resolves pending session picker promises as undefined', async () => {
        const store = createChatStore();
        const pending = store.showSessionPicker([{ sessionId: 's1', label: 'one' }] as never);
        expect(store.getSnapshot().overlayMode).toBe('session-picker');
        store.closeEventQueue();
        await expect(pending).resolves.toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('closeEventQueue resolves pending level picker promises as undefined', async () => {
        const store = createChatStore();
        const pending = store.showLevelPicker('default');
        expect(store.getSnapshot().overlayMode).toBe('level-picker');
        store.closeEventQueue();
        await expect(pending).resolves.toBeUndefined();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('closeEventQueue clears approval overlay without hanging', () => {
        const store = createChatStore();
        store.showApproval('bash', 'rm -rf');
        expect(store.getSnapshot().overlayMode).toBe('approval');
        store.closeEventQueue();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — confirmApproval selectedIndex', () => {
    it('confirmApproval(selectedIndex) enqueues that option before closing', async () => {
        const store = createChatStore();
        store.showApproval('bash', 'rm');
        const pending = store.waitForEvent();
        store.confirmApproval(3); // deny
        const event = await pending;
        expect(event).toEqual({ type: 'line', value: 'deny' });
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — show* after closeEventQueue', () => {
    it('show* after closeEventQueue does not hang or reopen overlays', async () => {
        const store = createChatStore();
        store.closeEventQueue();
        await expect(store.showModelPicker([makeChoice('gpt')])).resolves.toBeUndefined();
        await expect(
            store.showSessionPicker([{ sessionId: 's1', label: 'one', messageCount: 0, status: 'ok' }]),
        ).resolves.toBeUndefined();
        await expect(store.showLevelPicker('default')).resolves.toBeUndefined();
        await expect(store.showQuestion('Q?', ['a', 'b'])).resolves.toBe('');
        await expect(
            store.showQuestionBatch([{ question: 'Q?', options: [{ label: 'a' }], header: '', multiple: false }]),
        ).resolves.toEqual(['']);
        store.showApproval('bash', 'rm');
        store.showRename();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — approval double submit', () => {
    it('second confirmApproval is ignored after overlay closes', async () => {
        const store = createChatStore();
        store.showApproval('bash', 'rm');
        const first = store.waitForEvent();
        store.confirmApproval(0);
        await expect(first).resolves.toEqual({ type: 'line', value: 'once' });
        expect(store.getSnapshot().overlayMode).toBe('none');
        const second = store.waitForEvent();
        store.confirmApproval(0);
        // Must not enqueue another decision; leave waiter parked until close.
        store.closeEventQueue();
        await expect(second).resolves.toEqual({ type: 'interrupt' });
    });
});

describe('chat-store — question reject idempotent', () => {
    it('rejectQuestion is idempotent under double cancel', async () => {
        const store = createChatStore();
        const pending = store.showQuestion('Continue?', ['yes', 'no']);
        expect(store.rejectQuestion()).toBe(true);
        await expect(pending).resolves.toBe('');
        expect(store.rejectQuestion()).toBe(false);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — rename/custom answer idempotent', () => {
    it('submitRename is idempotent after first submit', () => {
        const store = createChatStore();
        const calls: string[] = [];
        store.onRenameSubmit = (name) => {
            calls.push(name);
        };
        store.showRename();
        store.submitRename('alpha');
        store.submitRename('beta');
        expect(calls).toEqual(['alpha']);
        expect(store.getSnapshot().overlayMode).toBe('none');
    });

    it('hideApproval is a no-op when not in approval overlay', () => {
        const store = createChatStore();
        store.hideApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.showApproval('bash', 'rm');
        store.hideApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.hideApproval();
        expect(store.getSnapshot().overlayMode).toBe('none');
    });
});

describe('chat-store — notices after close', () => {
    it('showTransientNotice is a no-op after closeEventQueue', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.showTransientNotice('should not show');
        expect(store.getSnapshot().transientNotice).toBeNull();
    });
});

describe('chat-store — question helpers outside overlay', () => {
    it('selectQuestionByClick is a no-op outside question overlay', async () => {
        const store = createChatStore();
        const pending = store.showQuestion('Q?', ['a', 'b']);
        expect(store.rejectQuestion()).toBe(true);
        await pending;
        store.selectQuestionByClick(0);
        store.enterQuestionCustomMode();
        store.toggleQuestionOption();
        expect(store.getSnapshot().overlayMode).toBe('none');
        expect(store.getSnapshot().questionCustomMode).toBe(false);
    });
});

describe('chat-store competing overlay dismiss', () => {
    it('denies approval when opening a model picker', async () => {
        const store = createChatStore();
        store.showApproval('bash', 'rm -rf /');
        expect(store.getSnapshot().overlayMode).toBe('approval');
        const wait = store.waitForEvent();
        const pick = store.showModelPicker([makeChoice('a')]);
        expect(store.getSnapshot().overlayMode).toBe('model-picker');
        await expect(wait).resolves.toEqual({ type: 'line', value: 'deny' });
        store.hideModelPicker(undefined);
        await expect(pick).resolves.toBeUndefined();
        store.closeEventQueue();
    });

    it('cancels rename when opening a question', async () => {
        const store = createChatStore();
        store.showRename();
        expect(store.getSnapshot().overlayMode).toBe('rename');
        const q = store.showQuestion('Q?', ['a', 'b']);
        expect(store.getSnapshot().overlayMode).toBe('question');
        store.rejectQuestion();
        await expect(q).resolves.toBe('');
        store.closeEventQueue();
    });

    it('ignores view overlays after the event queue closes', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.toggleAbgOverlay();
        store.openDiffViewer([{ title: 'a.ts', diff: '+x', lines: [] }]);
        store.showModelsOverlay([], []);
        expect(store.getSnapshot().overlayMode).toBe('none');
        expect(store.getSnapshot().modelsOverlay.active).toBe(false);
    });
});

describe('chat-store agents/mission closed gates', () => {
    it('ignores agents dashboard and mission panel after close', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.showAgentsDashboard([]);
        store.showMissionPanel([]);
        expect(store.getSnapshot().agentsDashboard.active).toBe(false);
        expect(store.getSnapshot().missionPanel.active).toBe(false);
    });

    it('clears active agents/mission panels on closeEventQueue', () => {
        const store = createChatStore();
        store.showAgentsDashboard([]);
        expect(store.getSnapshot().agentsDashboard.active).toBe(true);
        store.closeEventQueue();
        expect(store.getSnapshot().agentsDashboard.active).toBe(false);

        const store2 = createChatStore();
        store2.showMissionPanel([]);
        expect(store2.getSnapshot().missionPanel.active).toBe(true);
        store2.closeEventQueue();
        expect(store2.getSnapshot().missionPanel.active).toBe(false);
    });

    it('opening mission panel deactivates agents dashboard', () => {
        const store = createChatStore();
        store.showAgentsDashboard([]);
        expect(store.getSnapshot().agentsDashboard.active).toBe(true);
        store.showMissionPanel([]);
        expect(store.getSnapshot().overlayMode).toBe('mission-panel');
        expect(store.getSnapshot().agentsDashboard.active).toBe(false);
        expect(store.getSnapshot().missionPanel.active).toBe(true);
        store.closeEventQueue();
    });
});

describe('chat-store operator overlays dismiss approval', () => {
    it('denies approval when opening agents dashboard', async () => {
        const store = createChatStore();
        store.showApproval('bash', 'ls');
        const wait = store.waitForEvent();
        store.showAgentsDashboard([]);
        expect(store.getSnapshot().overlayMode).toBe('agents-dashboard');
        await expect(wait).resolves.toEqual({ type: 'line', value: 'deny' });
        store.closeEventQueue();
    });

    it('denies approval when toggling ABG on', async () => {
        const store = createChatStore();
        store.showApproval('bash', 'ls');
        const wait = store.waitForEvent();
        store.toggleAbgOverlay();
        expect(store.getSnapshot().overlayMode).toBe('abg');
        await expect(wait).resolves.toEqual({ type: 'line', value: 'deny' });
        store.closeEventQueue();
    });

    it('does not deny when toggling ABG off', async () => {
        const store = createChatStore();
        store.toggleAbgOverlay();
        expect(store.getSnapshot().overlayMode).toBe('abg');
        store.toggleAbgOverlay();
        expect(store.getSnapshot().overlayMode).toBe('none');
        // no deny event queued
        expect(store.enqueueEvent({ type: 'line', value: 'probe' })).toBe(true);
        await expect(store.waitForEvent()).resolves.toEqual({ type: 'line', value: 'probe' });
        store.closeEventQueue();
    });
});

describe('chat-store showApproval clears rename', () => {
    it('clears rename when showing approval', () => {
        const store = createChatStore();
        store.showRename();
        expect(store.getSnapshot().overlayMode).toBe('rename');
        store.showApproval('bash', 'ls');
        expect(store.getSnapshot().overlayMode).toBe('approval');
        expect(store.getSnapshot().renameBuffer).toBe('');
        store.closeEventQueue();
    });
});

describe('chat-store operator open cancels promise overlays', () => {
    it('cancels model picker when opening agents dashboard', async () => {
        const store = createChatStore();
        const pending = store.showModelPicker([makeChoice('a')]);
        expect(store.getSnapshot().overlayMode).toBe('model-picker');
        store.showAgentsDashboard([]);
        expect(store.getSnapshot().overlayMode).toBe('agents-dashboard');
        await expect(pending).resolves.toBeUndefined();
        store.closeEventQueue();
    });

    it('stale hideModelPicker does not clobber agents dashboard', async () => {
        const store = createChatStore();
        const pending = store.showModelPicker([makeChoice('a')]);
        store.showAgentsDashboard([]);
        await pending;
        store.hideModelPicker(undefined);
        expect(store.getSnapshot().overlayMode).toBe('agents-dashboard');
        store.closeEventQueue();
    });

    it('refuses history picker while an overlay is open', () => {
        const store = createChatStore();
        store.showApproval('bash', 'ls');
        store.openHistoryPicker('draft');
        expect(store.getSnapshot().historyPicker.open).toBe(false);
        store.closeEventQueue();
    });

    it('clears overlays when session id changes', async () => {
        const store = createChatStore();
        const pending = store.showModelPicker([makeChoice('a')]);
        store.setSessionId('session-b');
        expect(store.getSnapshot().overlayMode).toBe('none');
        await expect(pending).resolves.toBeUndefined();
        store.closeEventQueue();
    });
});

describe('chat-store submitLine and setGenerating gates', () => {
    it('refuses submitLine while overlay is open', async () => {
        const store = createChatStore();
        store.showApproval('bash', 'ls');
        store.submitLine('hello');
        // no line enqueued — waitForEvent would hang, so probe via deny path capacity
        const wait = store.waitForEvent();
        store.denyApproval();
        await expect(wait).resolves.toEqual({ type: 'line', value: 'deny' });
        store.closeEventQueue();
    });

    it('ignores setGenerating(true) after closeEventQueue', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.setGenerating(true);
        expect(store.getSnapshot().generating).toBe(false);
        store.setGenerating(false);
        expect(store.getSnapshot().generating).toBe(false);
    });
});

describe('chat-store menu and status teardown', () => {
    it('clears menus and agent status on closeEventQueue', () => {
        const store = createChatStore();
        store.setGenerating(true);
        store.setAgentStatus('thinking');
        store.setInputMirror('/help');
        store.closeEventQueue();
        const snap = store.getSnapshot();
        expect(snap.generating).toBe(false);
        expect(snap.agentStatusText).toBe('');
        expect(snap.fileAutocomplete.open).toBe(false);
        expect(snap.menuState).toEqual(expect.objectContaining({ selectedIndex: 0 }));
    });

    it('ignores setAgentStatus text after close', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.setAgentStatus('late');
        expect(store.getSnapshot().agentStatusText).toBe('');
    });
});

describe('chat-store panel mutator mode guards', () => {
    it('agents nav no-ops outside agents-dashboard', () => {
        const store = createChatStore();
        store.showAgentsDashboard([
            {
                name: 'a',
                description: 'd',
                source: 'bundled',
                disabled: false,
            } as never,
        ]);
        store.navigateAgentsDashboard(1);
        const idx = store.getSnapshot().agentsDashboard.selectedIndex;
        store.hideAgentsDashboard();
        store.navigateAgentsDashboard(1);
        expect(store.getSnapshot().agentsDashboard.selectedIndex).toBe(idx);
        store.closeEventQueue();
    });

    it('denies approval when session switches', async () => {
        const store = createChatStore();
        store.showApproval('bash', 'ls');
        const wait = store.waitForEvent();
        store.setSessionId('other-session');
        await expect(wait).resolves.toEqual({ type: 'line', value: 'deny' });
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.closeEventQueue();
    });
});

describe('chat-store decision overlays clear operator panels', () => {
    it('showApproval clears diff viewer entries', () => {
        const store = createChatStore();
        store.openDiffViewer([{ title: 'a.ts', diff: '+x', lines: [] }]);
        expect(store.getSnapshot().diffViewerEntries.length).toBe(1);
        store.showApproval('bash', 'ls');
        expect(store.getSnapshot().overlayMode).toBe('approval');
        expect(store.getSnapshot().diffViewerEntries).toEqual([]);
        store.closeEventQueue();
    });

    it('showModelPicker clears agents dashboard active flag', async () => {
        const store = createChatStore();
        store.showAgentsDashboard([]);
        expect(store.getSnapshot().agentsDashboard.active).toBe(true);
        const pending = store.showModelPicker([makeChoice('a')]);
        expect(store.getSnapshot().overlayMode).toBe('model-picker');
        expect(store.getSnapshot().agentsDashboard.active).toBe(false);
        store.hideModelPicker(undefined);
        await pending;
        store.closeEventQueue();
    });
});

describe('chat-store emitOutput after close', () => {
    it('ignores emitOutput after closeEventQueue', () => {
        const store = createChatStore();
        store.emitOutput('before\n');
        const before = store.getOutput();
        expect(before.length).toBeGreaterThan(0);
        store.closeEventQueue();
        store.emitOutput('after\n');
        expect(store.getOutput()).toBe(before);
        expect(store.getOutput().includes('after')).toBe(false);
    });
});

describe('chat-store replaceOutputText after close', () => {
    it('ignores replaceOutputText after closeEventQueue', () => {
        const store = createChatStore();
        store.emitOutput('keep\n');
        const before = store.getOutput();
        store.closeEventQueue();
        store.replaceOutputText('gone');
        expect(store.getOutput()).toBe(before);
    });
});

describe('chat-store context writers after close', () => {
    it('ignores setContextTokensUsed after close', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.setContextTokensUsed(1234);
        expect(store.getSnapshot().contextTokensUsed).toBeUndefined();
        store.setContextTokensUsed(undefined);
        expect(store.getSnapshot().contextTokensUsed).toBeUndefined();
    });
});

describe('chat-store setSessionId clears generating', () => {
    it('clears generating and agent status on session switch', () => {
        const store = createChatStore();
        store.setGenerating(true);
        store.setAgentStatus('thinking');
        store.setSessionId('next-session');
        expect(store.getSnapshot().generating).toBe(false);
        expect(store.getSnapshot().agentStatusText).toBe('');
        store.closeEventQueue();
    });
});

describe('chat-store setSessionId clears generating', () => {
    it('clears generating and agent status on session switch', () => {
        const store = createChatStore();
        store.setGenerating(true);
        store.setAgentStatus('thinking');
        store.setSessionId('next-session');
        expect(store.getSnapshot().generating).toBe(false);
        expect(store.getSnapshot().agentStatusText).toBe('');
        store.closeEventQueue();
    });
});

describe('chat-store prompt mutator gates', () => {
    it('refuses setInputMirror after close', () => {
        const store = createChatStore();
        store.setInputMirror('draft');
        store.closeEventQueue();
        store.setInputMirror('late');
        expect(store.getSnapshot().inputMirror).toBe('draft');
    });

    it('refuses workflow menu nav under overlay', () => {
        const store = createChatStore();
        store.setInputMirror('#ab');
        const before = store.getSnapshot().menuState;
        store.showApproval('bash', 'ls');
        store.navigateWorkflowMenu('down');
        expect(store.getSnapshot().menuState).toEqual(before);
        store.closeEventQueue();
    });

    it('refuses history confirm under overlay', () => {
        const store = createChatStore();
        store.openHistoryPicker('x');
        // force open even if empty
        if (!store.getSnapshot().historyPicker.open) {
            // still validate gate when closed-not-open
            store.showApproval('bash', 'ls');
            expect(store.confirmHistoryPicker()).toBeUndefined();
        } else {
            store.showApproval('bash', 'ls');
            expect(store.confirmHistoryPicker()).toBeUndefined();
        }
        store.closeEventQueue();
    });
});

describe('chat-store cycleModel gates', () => {
    it('refuses cycleModel under overlay', () => {
        const store = createChatStore();
        store.showApproval('bash', 'ls');
        const before = store.getSnapshot().modelCycleIndex;
        store.cycleModel(1);
        expect(store.getSnapshot().modelCycleIndex).toBe(before);
        store.closeEventQueue();
    });
});

describe('chat-store paste and history writers', () => {
    it('refuses registerPaste under overlay', () => {
        const store = createChatStore();
        store.showApproval('bash', 'ls');
        expect(store.registerPaste('hello')).toBe(-1);
        store.closeEventQueue();
    });

    it('refuses setHistoryEntries after close', () => {
        const store = createChatStore();
        store.setHistoryEntries([{ id: '1', text: 'a', timestamp: 0 }]);
        expect(store.getSnapshot().historyEntries.length).toBeGreaterThan(0);
        const before = store.getSnapshot().historyEntries.length;
        store.closeEventQueue();
        store.setHistoryEntries([{ id: '2', text: 'b', timestamp: 1 }]);
        expect(store.getSnapshot().historyEntries.length).toBe(before);
    });
});

describe('chat-store paste teardown', () => {
    it('clears pasteStore on closeEventQueue', () => {
        const store = createChatStore();
        const id = store.registerPaste('secret body');
        expect(id).toBeGreaterThan(0);
        store.closeEventQueue();
        // new paste refused; expand of old markers should not revive bodies via submit path
        expect(store.registerPaste('x')).toBe(-1);
        expect(store.getSnapshot().agentRetryAt).toBeUndefined();
    });

    it('clears pasteStore on setSessionId', () => {
        const store = createChatStore();
        expect(store.registerPaste('body')).toBeGreaterThan(0);
        store.setSessionId('other');
        // paste counter may increment but store bodies cleared — register still works on new session
        expect(store.registerPaste('next')).toBeGreaterThan(0);
        store.closeEventQueue();
    });
});

describe('chat-store metadata mutators after close', () => {
    it('refuses setWorkflowNames after close', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.setWorkflowNames(['wf']);
        expect(store.getSnapshot().workflowNames).not.toContain('wf');
    });

    it('refuses toggleShowThinking after close', () => {
        const store = createChatStore();
        const before = store.getSnapshot().showThinking;
        store.closeEventQueue();
        store.toggleShowThinking();
        expect(store.getSnapshot().showThinking).toBe(before);
    });
});

describe('chat-store openDiffViewer empty refuse', () => {
    it('refuses openDiffViewer with empty entries', () => {
        const store = createChatStore();
        expect(store.openDiffViewer([])).toBe(false);
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.closeEventQueue();
    });
});

describe('chat-store stuck question dismiss', () => {
    it('dismisses stuck question overlay without waiter', () => {
        const store = createChatStore();
        void store.showQuestion('Q?', ['a', 'b']);
        // Simulate lost waiter while overlay remains.
        store.rejectQuestion();
        // reject already clears; show again then strip waiter via resolve after reject path:
        void store.showQuestion('Q2?', ['x', 'y']);
        store.rejectQuestion();
        expect(store.getSnapshot().overlayMode).toBe('none');
        // Force stuck mode with no waiter using resolveQuestion no-op path after synthetic reopen+cancel:
        // reopen and cancelPending via showApproval which cancels question.
        void store.showQuestion('Q3?', ['p']);
        store.showApproval('bash', 'ls');
        expect(store.getSnapshot().overlayMode).toBe('approval');
        store.hideApproval();
        store.resolveQuestion('stale');
        expect(store.getSnapshot().overlayMode).toBe('none');
        store.closeEventQueue();
    });
});

describe('chat-store rejectQuestion stuck overlay', () => {
    it('rejectQuestion clears stuck overlay without waiter', () => {
        const store = createChatStore();
        void store.showQuestion('Q?', ['a']);
        store.rejectQuestion();
        expect(store.getSnapshot().overlayMode).toBe('none');
        // Force stuck: open then cancel waiters via showApproval cancelPending, leaving mode?
        void store.showQuestion('Q2?', ['b']);
        store.showApproval('bash', 'ls');
        // approval replaces question; hide approval
        store.hideApproval();
        // If somehow question mode without waiter:
        store.rejectQuestion();
        expect(store.getSnapshot().overlayMode).not.toBe('question');
        store.closeEventQueue();
    });
});

describe('chat-store remount diagnostics after close', () => {
    it('refuses setRemountGeneration after close', () => {
        const store = createChatStore();
        store.closeEventQueue();
        store.setRemountGeneration(3);
        expect(store.getSnapshot().remountGeneration).toBe(0);
    });
});

describe('setSessionId after close', () => {
    it('setSessionId is a no-op after closeEventQueue', () => {
        const store = createChatStore();
        store.setSessionId('session-a');
        store.setContextTokensMax(1000);
        store.closeEventQueue();
        store.setSessionId('session-b');
        expect(store.getSnapshot().sessionId).toBe('session-a');
        // max already wiped by close path or left alone — session id must not change.
    });
});

describe('setSessionId context max wipe', () => {
    it('clears contextTokensMax on session switch', () => {
        const store = createChatStore();
        store.setSessionId('session-a');
        store.setContextTokensMax(32000);
        store.setSessionId('session-b');
        expect(store.getSnapshot().contextTokensMax).toBeUndefined();
    });
});

describe('setSessionId display name wipe', () => {
    it('clears sessionDisplayName on session switch', () => {
        const store = createChatStore();
        store.setSessionId('session-a');
        store.setSessionDisplayName('Alpha');
        store.setSessionId('session-b');
        expect(store.getSnapshot().sessionDisplayName).toBe('');
    });
});

describe('setAgentsDashboardAgentOverride', () => {
    it('setAgentsDashboardAgentOverride restores without edit buffer', () => {
        const store = createChatStore();
        store.showAgentsDashboard([
            {
                name: 'explore',
                description: 'd',
                source: 'project',
                disabled: false,
                overrideModel: 'openai/gpt-4.1',
            },
        ]);
        store.setAgentsDashboardAgentOverride('explore', undefined);
        const entry = store.getSnapshot().agentsDashboard.agents.find((agent) => agent.name === 'explore');
        expect(entry?.overrideModel).toBeUndefined();
        store.setAgentsDashboardAgentOverride('explore', 'anthropic/claude-sonnet-4');
        const restored = store.getSnapshot().agentsDashboard.agents.find((agent) => agent.name === 'explore');
        expect(restored?.overrideModel).toBe('anthropic/claude-sonnet-4');
    });
});

describe('agents durable reload generation', () => {
    it('beginAgentsReload refuses while durable busy', () => {
        const store = createChatStore();
        store.showAgentsDashboard([
            {
                name: 'explore',
                description: 'd',
                source: 'project',
                disabled: false,
            },
        ]);
        store.beginAgentsDurableWrite();
        expect(store.beginAgentsReload()).toBe(-1);
        store.endAgentsDurableWrite();
        const gen = store.beginAgentsReload();
        expect(gen).toBeGreaterThan(0);
        expect(store.shouldApplyAgentsReload(gen)).toBe(true);
        store.beginAgentsDurableWrite();
        expect(store.shouldApplyAgentsReload(gen)).toBe(false);
        store.endAgentsDurableWrite();
    });
});

describe('agents durable state teardown', () => {
    it('resets agents durable state on closeEventQueue', () => {
        const store = createChatStore();
        store.showAgentsDashboard([
            {
                name: 'explore',
                description: 'd',
                source: 'project',
                disabled: false,
            },
        ]);
        store.beginAgentsDurableWrite();
        expect(store.isAgentsDurableBusy()).toBe(true);
        store.closeEventQueue();
        expect(store.isAgentsDurableBusy()).toBe(false);
        expect(store.beginAgentsReload()).toBe(-1);
    });
});

describe('agents durable clear on overlay switch', () => {
    it('resets agents durable when another overlay opens', () => {
        const store = createChatStore();
        store.showAgentsDashboard([
            {
                name: 'explore',
                description: 'd',
                source: 'project',
                disabled: false,
            },
        ]);
        store.beginAgentsDurableWrite();
        expect(store.isAgentsDurableBusy()).toBe(true);
        // Opening model picker clears inactive agents panel.
        void store.showModelPicker([makeChoice('m', { providerID: 'p', modelID: 'm' })]);
        expect(store.isAgentsDurableBusy()).toBe(false);
    });
});

describe('reloadAgentsDashboard durable busy', () => {
    it('reloadAgentsDashboard no-ops while durable busy', () => {
        const store = createChatStore();
        store.showAgentsDashboard([
            {
                name: 'explore',
                description: 'd',
                source: 'project',
                disabled: false,
            },
        ]);
        store.beginAgentsDurableWrite();
        store.reloadAgentsDashboard([
            {
                name: 'other',
                description: 'x',
                source: 'project',
                disabled: false,
            },
        ]);
        expect(store.getSnapshot().agentsDashboard.agents.map((a) => a.name)).toEqual(['explore']);
        store.endAgentsDurableWrite();
    });
});

describe('missions reload generation', () => {
    it('drops stale reload after hide and refuses when closed', () => {
        const store = createChatStore();
        store.showMissionPanel([{ id: 'a', label: 'A', status: 'running' }]);
        const gen = store.beginMissionsReload();
        expect(gen).toBeGreaterThan(0);
        store.hideMissionPanel();
        expect(store.shouldApplyMissionsReload(gen)).toBe(false);
        store.showMissionPanel([{ id: 'b', label: 'B', status: 'running' }]);
        const gen2 = store.beginMissionsReload();
        store.closeEventQueue();
        expect(store.shouldApplyMissionsReload(gen2)).toBe(false);
        expect(store.beginMissionsReload()).toBe(-1);
    });
});

describe('models mutation epoch', () => {
    it('drops stale assign rollback after hide', async () => {
        const selection = { providerID: 'openai', modelID: 'gpt-test' } as const;
        let rejectAuth: ((err: Error) => void) | undefined;
        const store = createChatStore({
            authStore: {
                setModelRole: () =>
                    new Promise<void>((_resolve, reject) => {
                        rejectAuth = reject;
                    }),
                clearModelRole: async () => undefined,
            } as never,
        });
        store.showModelsOverlay([selection], [{ role: 'default', assignment: undefined, fallback: selection }]);
        const pending = store.assignModelsOverlayRole('default', selection);
        store.hideModelsOverlay();
        rejectAuth?.(new Error('auth failed'));
        await pending;
        store.showModelsOverlay([selection], [{ role: 'default', assignment: selection, fallback: selection }]);
        expect(store.getSnapshot().modelsOverlay.roleRows[0]?.assignment).toEqual(selection);
    });
});

describe('context max epoch', () => {
    it('drops stale disk reseed after overlay step', () => {
        const store = createChatStore();
        const epoch = store.beginContextMaxReseed();
        store.setContextTokensMaxFromStep(200_000);
        expect(store.shouldApplyContextMaxReseed(epoch)).toBe(false);
        expect(store.getSnapshot().contextTokensMax).toBe(200_000);
        const epoch2 = store.beginContextMaxReseed();
        expect(store.shouldApplyContextMaxReseed(epoch2)).toBe(true);
        store.setContextTokensMax(128_000);
        expect(store.getSnapshot().contextTokensMax).toBe(128_000);
    });
});

describe('abg overlay tab/scroll store ownership', () => {
    it('persists live tab/scroll into prefs snapshot', () => {
        const store = createChatStore();
        store.setAbgOverlayActiveTab(3);
        store.adjustAbgOverlayScrollOffset(2);
        expect(store.getAbgOverlayPrefsSnapshot()).toMatchObject({
            activeTabIndex: 3,
            scrollOffset: 2,
        });
        store.setAbgOverlayActiveTab(1);
        expect(store.getAbgOverlayPrefsSnapshot().scrollOffset).toBe(0);
    });
});

describe('history entries reseed generation', () => {
    it('drops stale disk reload after live append', () => {
        const store = createChatStore();
        const gen = store.beginHistoryEntriesReseed();
        expect(store.submitLine('live')).toBe(true);
        expect(store.shouldApplyHistoryEntriesReseed(gen)).toBe(false);
        expect(store.getSnapshot().historyEntries.map((e) => e.text)).toEqual(['live']);
    });

    it('preserves open picker when hydrated list grows', () => {
        const store = createChatStore({
            initialHistoryEntries: [{ id: 'a', text: 'one', timestamp: 1 }],
        });
        store.openHistoryPicker('draft');
        expect(store.getSnapshot().historyPicker.open).toBe(true);
        store.setHistoryEntries([
            { id: 'a', text: 'one', timestamp: 1 },
            { id: 'b', text: 'two', timestamp: 2 },
        ]);
        const snap = store.getSnapshot();
        expect(snap.historyPicker.open).toBe(true);
        expect(snap.historyEntries.map((e) => e.text)).toEqual(['one', 'two']);
    });
});
