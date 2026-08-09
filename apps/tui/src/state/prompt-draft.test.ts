import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearPromptDraft,
    flushPromptDraftSync,
    notePromptDraft,
    promptDraftPath,
    readPromptDraft,
    registerPromptDraftFlushGlobal,
    resetPromptDraftForTests,
    unregisterPromptDraftFlushGlobal,
} from './prompt-draft';

const roots: string[] = [];

afterEach(() => {
    resetPromptDraftForTests();
    vi.useRealTimers();
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function tempDataDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'mctrl-prompt-draft-'));
    roots.push(root);
    return root;
}

describe('prompt-draft', () => {
    it('debounces writes and flushes the latest text', () => {
        vi.useFakeTimers();
        const dataDir = tempDataDir();
        notePromptDraft({ dataDir, sessionId: 'session_a', text: 'hello' });
        notePromptDraft({ dataDir, sessionId: 'session_a', text: 'hello world' });
        vi.runAllTimers();
        const record = readPromptDraft(dataDir, 'session_a');
        expect(record?.text).toBe('hello world');
        const raw = readFileSync(promptDraftPath(dataDir, 'session_a'), 'utf8');
        expect(JSON.parse(raw)).toMatchObject({ version: 1, sessionId: 'session_a', text: 'hello world' });
    });

    it('clears empty drafts immediately without waiting for debounce', () => {
        vi.useFakeTimers();
        const dataDir = tempDataDir();
        notePromptDraft({ dataDir, sessionId: 'session_submit', text: 'about to send' });
        vi.runAllTimers();
        expect(readPromptDraft(dataDir, 'session_submit')?.text).toBe('about to send');
        notePromptDraft({ dataDir, sessionId: 'session_submit', text: '' });
        // No timer advance: empty path flushes synchronously.
        expect(readPromptDraft(dataDir, 'session_submit')).toBeUndefined();
    });

    it('clears empty drafts and supports crash-path global flush', () => {
        vi.useFakeTimers();
        const dataDir = tempDataDir();
        notePromptDraft({ dataDir, sessionId: 'session_b', text: 'keep me' });
        vi.runAllTimers();
        expect(readPromptDraft(dataDir, 'session_b')?.text).toBe('keep me');

        notePromptDraft({ dataDir, sessionId: 'session_b', text: '   ' });
        vi.runAllTimers();
        expect(readPromptDraft(dataDir, 'session_b')).toBeUndefined();

        registerPromptDraftFlushGlobal();
        notePromptDraft({ dataDir, sessionId: 'session_c', text: 'crash draft' });
        const host = globalThis as typeof globalThis & { __mcFlushPromptDraft?: () => void };
        expect(typeof host.__mcFlushPromptDraft).toBe('function');
        host.__mcFlushPromptDraft?.();
        expect(readPromptDraft(dataDir, 'session_c')?.text).toBe('crash draft');
        clearPromptDraft(dataDir, 'session_c');
        expect(readPromptDraft(dataDir, 'session_c')).toBeUndefined();
        unregisterPromptDraftFlushGlobal();
        expect(host.__mcFlushPromptDraft).toBeUndefined();
    });

    it('flushPromptDraftSync is safe with no active draft', () => {
        expect(() => flushPromptDraftSync()).not.toThrow();
    });
});
