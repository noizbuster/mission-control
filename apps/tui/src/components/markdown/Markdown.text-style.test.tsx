import { describe, expect, it } from 'vitest';
import { CHAT_TEXT } from '../chat-theme';
import { darkTheme } from './interactive-theme';
import { markdownSyntaxStyles } from './Markdown';
import { darkSyntaxPalette } from './syntax-rules';

describe('markdownSyntaxStyles', () => {
    it('uses CHAT_TEXT for ordinary prose when the theme leaves it unset', () => {
        const styles = markdownSyntaxStyles(darkTheme);

        expect(styles['default']?.fg).toBe(CHAT_TEXT);
    });

    it('uses a theme default text foreground override for ordinary prose', () => {
        const defaultForeground = '#123456';
        const styles = markdownSyntaxStyles({ ...darkTheme, defaultTextStyle: { fg: defaultForeground } });

        expect(styles['default']?.fg).toBe(defaultForeground);
    });

    it('registers OpenTUI markup.* scopes (not the obsolete markdown.* names)', () => {
        const styles = markdownSyntaxStyles(darkTheme);

        expect(styles['markdown.heading']).toBeUndefined();
        expect(styles['markdown.bold']).toBeUndefined();
        expect(styles['markup.heading']).toBeDefined();
        expect(styles['markup.strong']).toBeDefined();
        expect(styles['markup.raw']).toBeDefined();
        expect(styles['markup.link.label']).toBeDefined();
        expect(styles['conceal']).toBeDefined();
    });

    it('styles headings bold purple matching OpenCode markdownHeading', () => {
        const styles = markdownSyntaxStyles(darkTheme);

        expect(styles['markup.heading']).toStrictEqual({
            bold: true,
            fg: darkSyntaxPalette.keyword,
        });
    });

    it('styles inline/code raw spans green matching OpenCode markdownCode', () => {
        const styles = markdownSyntaxStyles(darkTheme);

        expect(styles['markup.raw']?.fg).toBe(darkSyntaxPalette.string);
    });

    it('includes tree-sitter keyword scope for fenced code highlighting', () => {
        const styles = markdownSyntaxStyles(darkTheme);

        expect(styles['keyword']?.fg).toBe(darkSyntaxPalette.keyword);
        expect(styles['keyword']?.italic).toBe(true);
    });
});
