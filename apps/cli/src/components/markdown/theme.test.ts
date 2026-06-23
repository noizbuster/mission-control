import { describe, expect, it } from 'vitest';
import { darkTheme, noColorTheme, THEME_STYLE_KEYS } from './theme.js';

describe('TerminalMarkdownTheme built-ins', () => {
    it('darkTheme declares a style record for every required element key', () => {
        for (const key of THEME_STYLE_KEYS) {
            const style = darkTheme[key];
            expect(style, `${key} must be present`).toBeDefined();
            expect(typeof style, `${key} must be an object`).toBe('object');
        }
    });

    it('noColorTheme declares a style record for every required element key', () => {
        for (const key of THEME_STYLE_KEYS) {
            const style = noColorTheme[key];
            expect(style, `${key} must be present`).toBeDefined();
            expect(typeof style, `${key} must be an object`).toBe('object');
        }
    });

    it('darkTheme maps heading to bold cyan', () => {
        expect(darkTheme.heading).toStrictEqual({ bold: true, color: 'cyan' });
    });

    it('darkTheme marks inline code with a gray background', () => {
        expect(darkTheme.code).toStrictEqual({ backgroundColor: 'gray' });
    });

    it('darkTheme exposes a non-empty codeBlockIndent prefix', () => {
        expect(typeof darkTheme.codeBlockIndent).toBe('string');
        expect(darkTheme.codeBlockIndent?.length).toBeGreaterThan(0);
    });

    it('wires the highlightCode slot on darkTheme (T5) and leaves noColorTheme unset', () => {
        expect(typeof darkTheme.highlightCode).toBe('function');
        expect(noColorTheme.highlightCode).toBeUndefined();
    });

    it('leaves defaultTextStyle unset so terminals use their native base', () => {
        expect(darkTheme.defaultTextStyle).toBeUndefined();
        expect(noColorTheme.defaultTextStyle).toBeUndefined();
    });
});

describe('noColorTheme color-freedom', () => {
    it('sets no color or backgroundColor on any element style', () => {
        for (const key of THEME_STYLE_KEYS) {
            const style = noColorTheme[key];
            expect(style.color, `${key}.color must be unset`).toBeUndefined();
            expect(style.backgroundColor, `${key}.backgroundColor must be unset`).toBeUndefined();
        }
    });

    it('still conveys semantics via non-color attributes', () => {
        expect(noColorTheme.heading.bold).toBe(true);
        expect(noColorTheme.link.underline).toBe(true);
        expect(noColorTheme.code.inverse).toBe(true);
        expect(noColorTheme.strikethrough.strikethrough).toBe(true);
    });
});

describe('THEME_STYLE_KEYS contract', () => {
    it('enumerates the 14 element keys mirrored from pi', () => {
        expect(THEME_STYLE_KEYS).toHaveLength(14);
        expect(Array.from(THEME_STYLE_KEYS)).toContain('heading');
        expect(Array.from(THEME_STYLE_KEYS)).toContain('linkUrl');
        expect(Array.from(THEME_STYLE_KEYS)).toContain('codeBlockBorder');
        expect(Array.from(THEME_STYLE_KEYS)).toContain('strikethrough');
    });
});
