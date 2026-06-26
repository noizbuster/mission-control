/**
 * opentui-native terminal markdown theme.
 *
 * Each style entry is a descriptor of opentui `<text>` styling. Boolean flags
 * (`bold`, `underline`, ...) are authored as FLAT top-level props; a nested
 * `attributes` object is also accepted for consumers that author it that way.
 * The markdown renderer normalizes each descriptor into the numeric
 * `attributes` bitmask opentui's `<text>` intrinsic expects before spreading
 * (see `terminalStyleToTextProps` in `text-attributes.ts`). The syntax
 * highlighter (T5) fills the `highlightCode` slot.
 */

import type { HighlightedLine } from './highlight.js';
import { highlightCode } from './highlight.js';

/**
 * Boolean attribute flags shared by the flat top-level props and the nested
 * `attributes` object. Named once so the two accepted shapes stay in sync.
 */
export type TextStyleAttributeFlags = {
    readonly bold?: boolean;
    readonly dim?: boolean;
    readonly italic?: boolean;
    readonly inverse?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
};

/**
 * opentui text style descriptor. `fg`/`bg` are hex strings. Boolean styling
 * flags may be authored either as FLAT top-level props (`bold`, `underline`,
 * ...) - the canonical, test-pinned form - or nested under an `attributes`
 * object, retained for external consumers that author styles that way. The
 * renderer normalizes both forms into the `TextAttributes` numeric bitmask.
 */
export type TerminalTextStyle = TextStyleAttributeFlags & {
    readonly fg?: string;
    readonly bg?: string;
    readonly attributes?: TextStyleAttributeFlags;
};

/**
 * Deep-merge text styles. `fg`/`bg` use last-wins; boolean attribute flags
 * combine additively so a bold base merged with an italic overlay yields both
 * flags. Both the flat top-level props and any nested `attributes` object are
 * read; the result is emitted in the canonical flat form so downstream
 * spread-merges and `terminalStyleToTextProps` see a single shape.
 */
export function mergeTextStyle(...styles: ReadonlyArray<TerminalTextStyle | undefined>): TerminalTextStyle {
    let fg: string | undefined;
    let bg: string | undefined;
    const flags: {
        bold?: boolean;
        dim?: boolean;
        italic?: boolean;
        inverse?: boolean;
        underline?: boolean;
        strikethrough?: boolean;
    } = {};
    for (const style of styles) {
        if (style === undefined) continue;
        if (style.fg !== undefined) fg = style.fg;
        if (style.bg !== undefined) bg = style.bg;
        if (style.bold === true) flags.bold = true;
        if (style.dim === true) flags.dim = true;
        if (style.italic === true) flags.italic = true;
        if (style.inverse === true) flags.inverse = true;
        if (style.underline === true) flags.underline = true;
        if (style.strikethrough === true) flags.strikethrough = true;
        const nested = style.attributes;
        if (nested !== undefined) {
            if (nested.bold === true) flags.bold = true;
            if (nested.dim === true) flags.dim = true;
            if (nested.italic === true) flags.italic = true;
            if (nested.inverse === true) flags.inverse = true;
            if (nested.underline === true) flags.underline = true;
            if (nested.strikethrough === true) flags.strikethrough = true;
        }
    }
    return {
        ...(fg !== undefined ? { fg } : {}),
        ...(bg !== undefined ? { bg } : {}),
        ...flags,
    };
}

export type HighlightCodeSlot = (code: string, lang?: string) => readonly HighlightedLine[];

export type TerminalMarkdownTheme = {
    readonly defaultTextStyle?: TerminalTextStyle;
    readonly heading: TerminalTextStyle;
    readonly link: TerminalTextStyle;
    readonly linkUrl: TerminalTextStyle;
    readonly code: TerminalTextStyle;
    readonly codeBlock: TerminalTextStyle;
    readonly codeBlockBorder: TerminalTextStyle;
    readonly quote: TerminalTextStyle;
    readonly quoteBorder: TerminalTextStyle;
    readonly hr: TerminalTextStyle;
    readonly listBullet: TerminalTextStyle;
    readonly bold: TerminalTextStyle;
    readonly italic: TerminalTextStyle;
    readonly strikethrough: TerminalTextStyle;
    readonly underline: TerminalTextStyle;
    readonly codeBlockIndent?: string;
    readonly highlightCode?: HighlightCodeSlot;
    readonly cacheKeyTag?: string;
};

export const THEME_STYLE_KEYS = [
    'heading',
    'link',
    'linkUrl',
    'code',
    'codeBlock',
    'codeBlockBorder',
    'quote',
    'quoteBorder',
    'hr',
    'listBullet',
    'bold',
    'italic',
    'strikethrough',
    'underline',
] as const satisfies readonly (keyof TerminalMarkdownTheme)[];

export type ThemeStyleKey = (typeof THEME_STYLE_KEYS)[number];

export const darkTheme: TerminalMarkdownTheme = {
    heading: { bold: true, fg: '#00ffff' },
    link: { fg: '#0000ff', underline: true },
    linkUrl: { fg: '#808080', dim: true },
    code: { bg: '#808080' },
    codeBlock: { bg: '#808080' },
    codeBlockBorder: { fg: '#808080', dim: true },
    quote: { italic: true, dim: true },
    quoteBorder: { fg: '#ff00ff' },
    hr: { dim: true },
    listBullet: { fg: '#ffff00' },
    bold: { bold: true },
    italic: { italic: true },
    strikethrough: { strikethrough: true },
    underline: { underline: true },
    codeBlockIndent: '  ',
    highlightCode,
    cacheKeyTag: 'd',
};

export const noColorTheme: TerminalMarkdownTheme = {
    heading: { bold: true },
    link: { underline: true },
    linkUrl: {},
    code: { inverse: true },
    codeBlock: { inverse: true },
    codeBlockBorder: {},
    quote: { italic: true },
    quoteBorder: {},
    hr: {},
    listBullet: { bold: true },
    bold: { bold: true },
    italic: { italic: true },
    strikethrough: { strikethrough: true },
    underline: { underline: true },
};
