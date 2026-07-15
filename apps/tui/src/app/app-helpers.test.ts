import { type ChatBlock, parseMessageBlocks } from '@mission-control/tui/chat';
import { describe, expect, it, vi } from 'vitest';
import { preserveBlockReferences, promptPanelRepaintKey } from './app-helpers';

vi.mock('@mission-control/tui', async () => await import('../terminal-text'));
vi.mock('@mission-control/tui/chat', async () => await import('../chat'));
vi.mock('@mission-control/core', () => ({
    ContinuationRuntime: class ContinuationRuntime {},
    MAIN_AGENT_ID: 'main',
    readBoulder: () => undefined,
    resolveMissionControlDataDir: () => '/tmp/mission-control-test',
    resolveUserConfigDir: () => '/tmp/mission-control-test-config',
}));

describe('preserveBlockReferences', () => {
    it('returns fresh block references when prev is empty (first render)', () => {
        const fresh = parseMessageBlocks('You: hi\nAssistant: hello');
        const result = preserveBlockReferences(fresh, []);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(fresh[0]);
        expect(result[1]).toBe(fresh[1]);
    });

    it('reuses every block reference when content is identical across calls', () => {
        const text = 'You: hi\nAssistant: hello';
        const prev = parseMessageBlocks(text);
        const fresh = parseMessageBlocks(text);
        // Fresh objects are NOT === prev objects (parseMessageBlocks always allocates).
        expect(fresh[0]).not.toBe(prev[0]);
        // After preservation, references are reused because content is unchanged.
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(prev[0]);
        expect(result[1]).toBe(prev[1]);
    });

    it('gives only the last block a fresh reference when text is appended to it', () => {
        const prev = parseMessageBlocks('You: hi\nAssistant: he');
        const fresh = parseMessageBlocks('You: hi\nAssistant: hello');
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(prev[0]); // unchanged block reuses reference
        expect(result[1]).not.toBe(prev[1]); // changed block gets fresh reference
        expect(result[1]).toBe(fresh[1]); // ... specifically the fresh one
        expect(result[1]?.lines).toEqual(['Assistant: hello']); // content correct
    });

    it('preserves references for unchanged leading blocks when a new block is appended', () => {
        const prev = parseMessageBlocks('You: q\nAssistant: a1');
        const fresh = parseMessageBlocks('You: q\nAssistant: a1\nYou: q2');
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(prev[0]); // You: q unchanged
        expect(result[1]).toBe(prev[1]); // Assistant: a1 unchanged
        expect(result[2]).toBe(fresh[2]); // newly appended block, fresh reference
    });

    it('reuses a multi-line block whose lines are element-wise equal', () => {
        const prev = parseMessageBlocks('tool: foo\nTarget: x\n+added\n-removed');
        const fresh = parseMessageBlocks('tool: foo\nTarget: x\n+added\n-removed');
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(prev[0]);
    });

    it('does not reuse a block when the kind differs at the same index', () => {
        const prev: readonly ChatBlock[] = [{ kind: 'user', lines: ['You: x'] }];
        const fresh: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: x'] }];
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(fresh[0]);
        expect(result[0]).not.toBe(prev[0]);
    });

    it('does not reuse a block when line count differs at the same index', () => {
        const prev: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: a', 'b'] }];
        const fresh: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: a'] }];
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(fresh[0]);
        expect(result[0]).not.toBe(prev[0]);
    });

    it('does not reuse a block when a single line differs', () => {
        const prev: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: a', 'b'] }];
        const fresh: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: a', 'c'] }];
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(fresh[0]);
        expect(result[0]).not.toBe(prev[0]);
    });

    it('reuses leading references when fresh is shorter than prev (tail block dropped)', () => {
        const prev = parseMessageBlocks('You: q\nAssistant: a\nError: oops');
        const fresh = parseMessageBlocks('You: q\nAssistant: a');
        const result = preserveBlockReferences(fresh, prev);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(prev[0]);
        expect(result[1]).toBe(prev[1]);
    });

    it('returns an empty array for empty fresh and empty prev', () => {
        const result = preserveBlockReferences([], []);
        expect(result).toEqual([]);
    });
});

describe('promptPanelRepaintKey', () => {
    it('changes when prompt-adjacent panel rows can shift around the native textarea', () => {
        expect(
            promptPanelRepaintKey({ inputMirror: '', fileAutocompleteOpen: false, fileMatchCount: 0, menuRows: 5 }),
        ).toBe('none');
        expect(
            promptPanelRepaintKey({ inputMirror: '/', fileAutocompleteOpen: false, fileMatchCount: 0, menuRows: 5 }),
        ).toBe('slash:/');
        expect(
            promptPanelRepaintKey({ inputMirror: '#', fileAutocompleteOpen: false, fileMatchCount: 0, menuRows: 5 }),
        ).toBe('workflow:#');
        expect(
            promptPanelRepaintKey({ inputMirror: '@', fileAutocompleteOpen: true, fileMatchCount: 28, menuRows: 5 }),
        ).toBe('file:@:28');
        expect(
            promptPanelRepaintKey({ inputMirror: '/', fileAutocompleteOpen: false, fileMatchCount: 0, menuRows: 0 }),
        ).toBe('none');
    });
});
