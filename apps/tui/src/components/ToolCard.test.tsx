/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from 'vitest';
import {
    buildHeaderLabel,
    hasDiffContent,
    shouldRenderToolBodyAsDiff,
    ToolCard,
    toolStatusPresentation,
} from './ToolCard';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./ToolCard.tsx', import.meta.url)), 'utf-8');

describe('hasDiffContent', () => {
    it('returns true when a block contains added/removed diff lines', () => {
        const lines = [
            'Edit preview for file.edit',
            'Target: src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '-old line',
            '+new line',
        ];
        expect(hasDiffContent(lines)).toBe(true);
    });

    it('returns true for a standalone removed line', () => {
        expect(hasDiffContent(['-only removed'])).toBe(true);
    });

    it('returns true for a standalone added line', () => {
        expect(hasDiffContent(['+only added'])).toBe(true);
    });

    it('returns true for hunk markers without +/- lines', () => {
        expect(hasDiffContent(['@@ -1,3 +1,4 @@'])).toBe(true);
    });

    it('returns true for +++ / --- meta lines', () => {
        expect(hasDiffContent(['+++ b/foo.ts', '--- a/foo.ts'])).toBe(true);
    });

    it('returns false for pure prose lines', () => {
        const lines = ['Command preview for command.run', '$ ls -la', 'Command output for bash.run'];
        expect(hasDiffContent(lines)).toBe(false);
    });

    it('returns false for a Target line without any +/- or @@ markers', () => {
        expect(hasDiffContent(['Target: src/app.ts'])).toBe(false);
    });

    it('returns false for an empty array', () => {
        expect(hasDiffContent([])).toBe(false);
    });

    it('does not treat mid-string dashes as diff markers', () => {
        expect(hasDiffContent(['some - inline text', 'a + b = c'])).toBe(false);
    });
});

describe('buildHeaderLabel', () => {
    it('uses the provided bare title for collapsed and expanded tool rows', () => {
        expect(buildHeaderLabel('file.edit')).toBe('file.edit');
    });

    it('falls back to a generic label when title is undefined', () => {
        expect(buildHeaderLabel(undefined)).toBe('Tool output');
    });
});

describe('ToolCard component', () => {
    it('exports a callable Solid component', () => {
        expect(typeof ToolCard).toBe('function');
    });

    it('routes expanded auto-mode diff content through DiffView', () => {
        expect(source).toContain('return hasDiffContent(lines);');
        expect(source).toContain('shouldRenderToolBodyAsDiff(lines(), bodyMode())');
        expect(source).toContain('<DiffView diff={lines().join');
    });

    it('keeps typed command literals as byte-preserving selectable plain rows', () => {
        // Given: a typed command body whose literal rows resemble unified diff syntax.
        const literalLines = ['+literal', '-literal', '@@ literal', '\tcommand tab', '  command whitespace', '   '];

        // When: the explicit body mode selects the existing plain-row renderer.
        const autoRendersAsDiff = shouldRenderToolBodyAsDiff(literalLines, 'auto');
        const plainRendersAsDiff = shouldRenderToolBodyAsDiff(literalLines, 'plain');

        // Then: inference remains available for auto callers while plain rows receive the original line values unchanged.
        expect(hasDiffContent(literalLines)).toBe(true);
        expect(autoRendersAsDiff).toBe(true);
        expect(plainRendersAsDiff).toBe(false);
        expect(source).toContain('const lines = () => props.lines;');
        expect(source).toContain('<For each={lines()}>');
        expect(source).toMatch(/<text selectable fg=\{CHAT_TEXT\}>\s*\{line\}\s*<\/text>/);
    });

    it('uses the existing tool icon with flat rows in both collapsed and expanded forms', () => {
        expect(source).toContain('toolIconForTitle');
        expect(source).toContain('CHAT_TOOL_ICON_WIDTH');
        expect(source).not.toContain("border={['left']}");
        expect(source).not.toContain('LEFT_ACCENT_BORDER');
        expect(source).not.toContain('backgroundColor={CHAT_PANEL_BG}');
        expect(source).not.toContain('paddingTop={CHAT_USER_PAD_Y}');
        expect(source).not.toContain('paddingBottom={CHAT_USER_PAD_Y}');
        expect(source).not.toContain('paddingLeft={CHAT_USER_PAD_X}');
        expect(source).not.toContain('gap={CHAT_USER_MARGIN_TOP}');
    });

    it('retains semantic status colors with glyphs that can suffix bare tool titles', () => {
        expect(toolStatusPresentation('running').label).toBeUndefined();
        expect(toolStatusPresentation('running').glyph).toBe('~');
        expect(toolStatusPresentation('failed').label).toBeUndefined();
        expect(toolStatusPresentation('failed').glyph).toBe('!');
    });
});
