import { describe, expect, it } from 'vitest';
import { CHAT_TEXT } from '../chat-theme';
import { darkTheme } from './interactive-theme';
import { markdownSyntaxStyles } from './Markdown';

describe('markdownSyntaxStyles', () => {
    it('uses CHAT_TEXT for ordinary prose when the theme leaves it unset', () => {
        const styles = markdownSyntaxStyles(darkTheme);

        expect(styles.default.fg).toBe(CHAT_TEXT);
    });

    it('uses a theme default text foreground override for ordinary prose', () => {
        const defaultForeground = '#123456';
        const styles = markdownSyntaxStyles({ ...darkTheme, defaultTextStyle: { fg: defaultForeground } });

        expect(styles.default.fg).toBe(defaultForeground);
    });

    it('keeps headings bold cyan', () => {
        const styles = markdownSyntaxStyles(darkTheme);

        expect(styles['markdown.heading']).toStrictEqual({ bold: true, fg: '#00ffff' });
    });
});
