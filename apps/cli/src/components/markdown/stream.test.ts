import remend from 'remend';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Block } from './stream.js';
import { streamBlocks } from './stream.js';

// Wrap the real remend in a spy so behavior tests exercise actual healing while
// individual cases can override the implementation (e.g. force a throw).
vi.mock('remend', async (importOriginal) => {
    const actual = await importOriginal<typeof import('remend')>();
    return { default: vi.fn(actual.default) };
});

describe('streamBlocks', () => {
    beforeEach(() => {
        vi.mocked(remend).mockClear();
    });

    it('returns a single full block when not live and skips remend', () => {
        const blocks = streamBlocks('# Hi\n\nbody', false);
        expect(blocks).toStrictEqual([{ raw: '# Hi\n\nbody', src: '# Hi\n\nbody', mode: 'full' }] satisfies Block[]);
        expect(remend).not.toHaveBeenCalled();
    });

    it('splits a trailing unterminated code fence into its own live block', () => {
        const blocks = streamBlocks('# Hi\n\n```ts\nconst x', true);
        expect(blocks.length).toBeGreaterThanOrEqual(2);
        const last = blocks[blocks.length - 1];
        expect(last).toBeDefined();
        expect(last?.mode).toBe('live');
        expect(last?.raw.startsWith('```')).toBe(true);
        expect(remend).toHaveBeenCalledWith('# Hi\n\n```ts\nconst x', { linkMode: 'text-only' });
    });

    it('heals partial bold without throwing and returns one live block', () => {
        const blocks = streamBlocks('**bold', true);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.mode).toBe('live');
        expect(blocks[0]?.raw).toBe('**bold');
        // remend closes the dangling marker; assert the close without pinning the whole string.
        expect(blocks[0]?.src.endsWith('**')).toBe(true);
    });

    it('routes reference-link text through a single live block', () => {
        const text = '[a]: https://x\n\n[a]';
        const blocks = streamBlocks(text, true);
        expect(blocks).toStrictEqual([{ raw: text, src: expect.any(String), mode: 'live' }]);
    });

    it('handles empty live input without throwing', () => {
        const blocks = streamBlocks('', true);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.mode).toBe('live');
    });

    it('falls back to one unhealed live block when remend throws on garbage', () => {
        vi.mocked(remend).mockImplementationOnce(() => {
            throw new Error('remend failure');
        });
        const garbage = '\x00\x01\x02 \ufffe binary';
        const blocks = streamBlocks(garbage, true);
        expect(blocks).toStrictEqual([{ raw: garbage, src: garbage, mode: 'live' }]);
    });
});
