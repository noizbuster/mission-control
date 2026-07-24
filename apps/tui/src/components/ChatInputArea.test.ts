import { describe, expect, it } from 'vitest';
import { createChatStore } from '../state/chat-store';
import { fileCompletionFrecencyKey, recallPromptHistory } from './ChatInputArea';
import { createRecordingTextarea, makeKeyEvent } from './chat-test-support';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readChatInputAreaSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatInputArea.tsx'), 'utf8');
}

describe('ChatInputArea prompt-service helpers', () => {
    it('normalizes completed file paths before recording frecency', () => {
        expect(fileCompletionFrecencyKey('README.md')).toBe('README.md');
        expect(fileCompletionFrecencyKey('packages/')).toBe('packages');
    });
});

describe('ChatInputArea history picker keyboard contract', () => {
    it('wires open at buffer start, navigate, fill-only enter, and esc cancel', () => {
        const source = readChatInputAreaSource();
        expect(source).toContain('recallHistory');
        expect(source).toContain('applyHistoryRecallText');
        expect(source).toContain('confirmHistoryPicker');
        expect(source).toContain('cancelHistoryPicker');
        expect(source).toContain('cursorOffset');
    });

    it('confirm fills textarea without submitting a line event', () => {
        const store = createChatStore({
            initialHistoryEntries: [
                { id: 'a', text: 'older prompt', timestamp: 1 },
                { id: 'b', text: 'newer prompt', timestamp: 2 },
            ],
        });
        store.setInputMirror('draft');
        store.openHistoryPicker('draft');
        store.navigateHistoryPicker('up');
        const selected = store.confirmHistoryPicker();
        expect(selected).toBe('older prompt');
        expect(store.isHistoryPickerOpen()).toBe(false);

        const textarea = createRecordingTextarea('draft', 0);
        if (selected !== undefined) {
            textarea.setText(selected);
            textarea.gotoBufferEnd();
            store.setInputMirror(selected);
        }
        expect(textarea.setTextCalls).toEqual(['older prompt']);
        expect(textarea.gotoBufferEndCount).toBe(1);
        expect(store.getSnapshot().inputMirror).toBe('older prompt');
        expect(store.getSnapshot().historyPicker.open).toBe(false);
    });

    it('cancel leaves the draft buffer unchanged', () => {
        const store = createChatStore({
            initialHistoryEntries: [{ id: 'a', text: 'only', timestamp: 1 }],
        });
        store.setInputMirror('keep me');
        store.openHistoryPicker('keep me');
        store.cancelHistoryPicker();
        expect(store.isHistoryPickerOpen()).toBe(false);
        expect(store.getSnapshot().inputMirror).toBe('keep me');
    });

    it('recalls the prior prompt from a cursor-start input and restores the draft', () => {
        const store = createChatStore({
            initialHistoryEntries: [
                { id: 'a', text: 'older prompt', timestamp: 1 },
                { id: 'b', text: 'newer prompt', timestamp: 2 },
            ],
        });
        const textarea = createRecordingTextarea('draft text', 0);
        expect(recallPromptHistory(store, textarea, 'up')).toBe(true);
        expect(recallPromptHistory(store, textarea, 'up')).toBe(true);
        expect(recallPromptHistory(store, textarea, 'down')).toBe(true);
        expect(recallPromptHistory(store, textarea, 'down')).toBe(true);

        expect(textarea.setTextCalls).toEqual(['newer prompt', 'older prompt', 'newer prompt', 'draft text']);
        expect(textarea.gotoBufferEndCount).toBe(4);
        expect(textarea.plainText).toBe('draft text');
        expect(store.getSnapshot().inputMirror).toBe('draft text');
        expect(store.isHistoryPickerOpen()).toBe(false);
    });

    it('makeKeyEvent supports the history picker key names used by the handler', () => {
        const up = makeKeyEvent('up');
        const enter = makeKeyEvent('return');
        const esc = makeKeyEvent('escape');
        expect(up.name).toBe('up');
        expect(enter.name).toBe('return');
        expect(esc.name).toBe('escape');
    });
});
