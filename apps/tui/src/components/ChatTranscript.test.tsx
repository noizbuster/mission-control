import { MacOSScrollAccel } from '@opentui/core';
import { describe, expect, it, vi } from 'vitest';
import {
    ChatTranscriptScrollbox,
    type ChatTranscriptScrollOptions,
    chatTranscriptScrollOptions,
    MarkdownPanel,
    MessageBlock,
} from './ChatTranscript.js';

vi.mock('@mission-control/tui', async () => await import('../terminal-text.js'));
vi.mock('@mission-control/tui/chat', async () => await import('../chat.js'));
vi.mock('@mission-control/core', () => ({
    resolveMissionControlDataDir: () => '/tmp/mission-control-test',
}));

describe('chatTranscriptScrollOptions', () => {
    it('builds the native scrollbox config with sticky-bottom macOS acceleration', () => {
        const opts = chatTranscriptScrollOptions();
        expect(opts.stickyScroll).toBe(true);
        expect(opts.stickyStart).toBe('bottom');
        expect(opts.scrollAcceleration).toBeInstanceOf(MacOSScrollAccel);
        expect(opts.flexGrow).toBe(1);
        expect(opts.width).toBe('100%');
    });

    it('omits maxHeight when none is given (honors exactOptionalPropertyTypes)', () => {
        const opts = chatTranscriptScrollOptions();
        expect(opts).not.toHaveProperty('maxHeight');
    });

    it('includes maxHeight when a value is given', () => {
        const opts = chatTranscriptScrollOptions(24);
        expect(opts.maxHeight).toBe(24);
    });

    it('keeps maxHeight when the value is 0 (does not treat 0 as absent)', () => {
        const opts = chatTranscriptScrollOptions(0);
        expect(opts.maxHeight).toBe(0);
    });

    it('preserves sticky-bottom behavior when resize changes the transcript height', () => {
        const tall = chatTranscriptScrollOptions(24);
        const short = chatTranscriptScrollOptions(10);

        expect([tall.stickyScroll, tall.stickyStart, tall.width, tall.maxHeight]).toEqual([true, 'bottom', '100%', 24]);
        expect([short.stickyScroll, short.stickyStart, short.width, short.maxHeight]).toEqual([
            true,
            'bottom',
            '100%',
            10,
        ]);
        expect(short.scrollAcceleration).toBeInstanceOf(MacOSScrollAccel);
    });
});

describe('ChatTranscript component exports', () => {
    it('keeps callable Solid component seams', () => {
        expect(typeof ChatTranscriptScrollbox).toBe('function');
        expect(typeof MessageBlock).toBe('function');
        expect(typeof MarkdownPanel).toBe('function');
    });

    it('keeps the scroll option type exact for maxHeight callers', () => {
        const opts = chatTranscriptScrollOptions(10) satisfies ChatTranscriptScrollOptions;
        expect(opts.maxHeight).toBe(10);
    });
});
