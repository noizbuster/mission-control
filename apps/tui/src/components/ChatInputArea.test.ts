import { describe, expect, it } from 'vitest';
import { createChatStore } from '../state/chat-store';
import { applyHistoryRecallText, fileCompletionFrecencyKey } from './ChatInputArea';
import { completionPromptListControls, historyPickerPromptListControls } from './prompt-list-controls';
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
    it('wires open at buffer start, navigate, fill-only Enter/Tab, and Esc cancel', () => {
        const source = readChatInputAreaSource();
        expect(source).toContain('openHistoryPicker');
        expect(source).toContain('navigateHistoryPicker');
        expect(source).toContain('confirmHistoryPicker');
        expect(source).toContain('cancelHistoryPicker');
        expect(source).toContain('cursorOffset');
        expect(source).toContain('historyPickerPromptListControls.acceptKeys.includes(\'tab\')');
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
            applyHistoryRecallText(store, textarea, selected);
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

    it('makeKeyEvent supports the history picker key names used by the handler', () => {
        const up = makeKeyEvent('up');
        const enter = makeKeyEvent('return');
        const esc = makeKeyEvent('escape');
        expect(up.name).toBe('up');
        expect(enter.name).toBe('return');
        expect(esc.name).toBe('escape');
        const tab = makeKeyEvent('tab');
        expect(tab.name).toBe('tab');
    });
});

describe('ChatInputArea prompt-list Tab acceptance contract', () => {
    it('uses each shared panel control definition to accept the matching open list without submission', () => {
        const source = readChatInputAreaSource();

        expect(historyPickerPromptListControls.acceptKeys).toContain('tab');
        expect(completionPromptListControls.acceptKeys).toContain('tab');
        expect(completionPromptListControls).toEqual({
            filterable: true,
            selectable: true,
            acceptKeys: ['tab', 'enter'],
            acceptVerb: 'complete',
            dismissible: true,
        });
        expect(source).toContain('historyPickerPromptListControls.acceptKeys.includes(\'tab\')');
        expect(source).toContain('completionPromptListControls.acceptKeys.includes(\'tab\')');
        expect(source).toContain('resolveWorkflowCommandMenuInsertText');
        expect(source).toContain('resolveSkillCommandMenuInsertText');
        expect(source).toContain('resolveSlashCommandMenuInsertText');
    });
});
