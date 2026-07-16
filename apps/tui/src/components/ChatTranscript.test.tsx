import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MacOSScrollAccel } from '@opentui/core';
import { describe, expect, it, vi } from 'vitest';
import {
    ChatTranscriptScrollbox,
    type ChatTranscriptScrollOptions,
    chatTranscriptScrollOptions,
    MarkdownPanel,
    MessageBlock,
} from './ChatTranscript';

vi.mock('@mission-control/tui', async () => await import('../terminal-text'));
vi.mock('@mission-control/tui/chat', async () => await import('../chat'));
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
        expect(opts.minHeight).toBe(0);
        expect(opts).not.toHaveProperty('width');
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

        expect([tall.stickyScroll, tall.stickyStart, tall.minHeight, tall.maxHeight]).toEqual([true, 'bottom', 0, 24]);
        expect([short.stickyScroll, short.stickyStart, short.minHeight, short.maxHeight]).toEqual([
            true,
            'bottom',
            0,
            10,
        ]);
        expect(tall).not.toHaveProperty('width');
        expect(short).not.toHaveProperty('width');
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

describe('ChatTranscript stream-stability topology', () => {
    it('lists blocks with Index (position) not For (identity) to avoid remount flicker', () => {
        const source = readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatTranscript.tsx'), 'utf8');
        const transcriptFn = source.slice(source.indexOf('export function ChatTranscript'));
        expect(transcriptFn).toContain('<Index each={props.blocks}>');
        expect(transcriptFn).not.toContain('<For each={props.blocks}>');
        expect(source).toContain('isStreaming={props.generating && index === props.blocks.length - 1}');
        expect(source).toContain('const joined = () => joinBlockText(lines(), prefix())');
        expect(source).toContain('streaming={streaming()}');
    });
});

describe('OpenCode-style transcript chrome', () => {
    it('uses left-accent user/error panels and padding-only assistant markdown', () => {
        const source = readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatTranscript.tsx'), 'utf8');

        expect(source).toContain('LEFT_ACCENT_BORDER');
        expect(source).toContain('CHAT_PRIMARY');
        expect(source).toContain('CHAT_PANEL_BG');
        expect(source).toContain('UserMessagePanel');
        expect(source).toContain('ErrorMessagePanel');
        expect(source).toContain('ThinkingHeader');
        expect(source).toContain('CHAT_ASSISTANT_PAD_LEFT');
        expect(source).not.toContain('BLOCK_LEFT_HEX');
        expect(source).not.toContain('barColor="#00ff00"');
        expect(source).not.toContain('barColor="#ff00ff"');
    });
});
