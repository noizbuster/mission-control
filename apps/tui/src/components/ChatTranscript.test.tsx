import { MacOSScrollAccel } from '@opentui/core';
import { describe, expect, it, vi } from 'vitest';
import {
    ChatTranscriptScrollbox,
    type ChatTranscriptScrollOptions,
    chatTranscriptScrollOptions,
} from './ChatTranscript';
import { LegacyMessageBlock, MarkdownPanel } from './LegacyTranscriptRenderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
        expect(typeof LegacyMessageBlock).toBe('function');
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
        const legacySource = readFileSync(
            resolve(process.cwd(), 'apps/tui/src/components/LegacyTranscriptRenderer.tsx'),
            'utf8',
        );
        expect(source).toContain('<Index each={props.blocks}>'); // legacy window still Index-positioned
        expect(source).not.toContain('<For each={props.blocks}>');
        expect(source).toContain('isStreaming={props.generating && absoluteIndex() === props.totalBlockCount - 1}');
        expect(source).toContain('selectTranscriptWindowByHeight');
        expect(legacySource).toContain('const joined = () => joinBlockText(lines(), prefix())');
        expect(legacySource).toContain('streaming={streaming()}');
    });

    it('uses typed parts as the sole transcript list whenever semantic rows exist', () => {
        const source = readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatTranscript.tsx'), 'utf8');
        const transcriptFn = source.slice(source.indexOf('export function ChatTranscript'));

        expect(transcriptFn).toContain('props.transcriptParts.length > 0');
        expect(transcriptFn).toContain('selectTranscriptWindowByHeight');
        expect(transcriptFn).toContain('heightCache');
        expect(transcriptFn).toContain('bindMeasuredRow');
        expect(transcriptFn).toContain('anchorIndexForTranscriptOffset');
        expect(transcriptFn).toContain('<Index each={typedWindow().visibleParts}>');
        expect(transcriptFn).toContain('<TranscriptPartRenderer');
        expect(transcriptFn).toContain('fallback={');
        expect(transcriptFn).toContain('<LegacyTranscriptBlocks');
        expect(transcriptFn).toContain('showThinking={props.showThinking}');
        expect(transcriptFn).toContain('transcriptParts={props.transcriptParts}');
        expect(transcriptFn).toContain('toolOutputExpanded={props.toolOutputExpanded}');
        expect(transcriptFn).toContain('activeAssistantMessageId');
        expect(transcriptFn).toContain('formatHiddenTranscriptBanner');
        expect(transcriptFn).toContain('transcriptWindowSpacerHeights');
        expect(transcriptFn).toContain('typedSpacers().beforeRows');
        expect(transcriptFn).toContain('typedSpacers().afterRows');
        expect(transcriptFn).toContain('legacySpacers().beforeRows');
        expect(transcriptFn).toContain('legacySpacers().afterRows');
    });

    it('passes final-row position reactively to typed transcript rows', () => {
        // Given: the typed transcript list and its renderer boundary.
        const transcriptSource = readFileSync(
            resolve(process.cwd(), 'apps/tui/src/components/ChatTranscript.tsx'),
            'utf8',
        );
        const rendererSource = readFileSync(
            resolve(process.cwd(), 'apps/tui/src/components/TranscriptPartRenderer.tsx'),
            'utf8',
        );
        const rowsSource = readFileSync(
            resolve(process.cwd(), 'apps/tui/src/components/TypedTranscriptRows.tsx'),
            'utf8',
        );

        // When: the source topology is checked without native FFI rendering.

        // Then: only the current final legacy part receives streaming ownership.
        expect(transcriptSource).toContain('isLast={absoluteIndex() === typedWindow().totalCount - 1}');
        expect(rendererSource).toContain('isLast={props.isLast}');
        expect(rowsSource).toContain('isFinalLegacyPartStreaming(props.generating, props.isLast)');
    });
});

describe('OpenCode-style transcript chrome', () => {
    it('uses left-accent user/error panels and padding-only assistant markdown', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'apps/tui/src/components/LegacyTranscriptRenderer.tsx'),
            'utf8',
        );

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
