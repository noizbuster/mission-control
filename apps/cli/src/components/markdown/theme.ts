/**
 * Ink-native terminal markdown theme.
 *
 * Each style entry is a descriptor of Ink `<Text>` props (color, backgroundColor,
 * bold, italic, underline, strikethrough, dimColor, inverse) — never an ANSI
 * string-producing function. The markdown renderer (T4) spreads these onto
 * `<Text>` elements; the syntax highlighter (T5) fills the `highlightCode` slot.
 *
 * Key set mirrors the ANSI-string `MarkdownTheme` from the pi reference repo,
 * but each value is an Ink-style descriptor object instead of a `(text) => string`
 * ANSI function.
 */

import type { HighlightedLine } from './highlight.js';
import { highlightCode } from './highlight.js';

/** Subset of Ink `<Text>` props that control character styling. */
export type InkTextStyle = {
    readonly color?: string;
    readonly backgroundColor?: string;
    readonly dimColor?: boolean;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
    readonly inverse?: boolean;
};

/**
 * Code-highlighting slot. Returns one {@link HighlightedLine} per source line,
 * each carrying per-token styled spans. The renderer maps each span to a styled
 * `<Text>` run. A missing slot means monochrome code blocks (no token coloring).
 */
export type HighlightCodeSlot = (code: string, lang?: string) => readonly HighlightedLine[];

/**
 * Theme mapping every markdown element to an Ink `<Text>` style descriptor.
 *
 * `defaultTextStyle` is the base style applied to all text unless overridden by
 * element-specific styling. `codeBlockIndent` is a layout prefix (string), not a
 * style. `highlightCode` is an optional function slot filled by T5.
 */
export type TerminalMarkdownTheme = {
    readonly defaultTextStyle?: InkTextStyle;
    readonly heading: InkTextStyle;
    readonly link: InkTextStyle;
    readonly linkUrl: InkTextStyle;
    readonly code: InkTextStyle;
    readonly codeBlock: InkTextStyle;
    readonly codeBlockBorder: InkTextStyle;
    readonly quote: InkTextStyle;
    readonly quoteBorder: InkTextStyle;
    readonly hr: InkTextStyle;
    readonly listBullet: InkTextStyle;
    readonly bold: InkTextStyle;
    readonly italic: InkTextStyle;
    readonly strikethrough: InkTextStyle;
    readonly underline: InkTextStyle;
    readonly codeBlockIndent?: string;
    readonly highlightCode?: HighlightCodeSlot;
    readonly cacheKeyTag?: string;
};

/** Element style keys mirrored from pi's `MarkdownTheme` (excludes layout/slots). */
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

/** Union of the element style keys enumerated by {@link THEME_STYLE_KEYS}. */
export type ThemeStyleKey = (typeof THEME_STYLE_KEYS)[number];

/** Default dark-palette theme. */
export const darkTheme: TerminalMarkdownTheme = {
    heading: { bold: true, color: 'cyan' },
    link: { color: 'blue', underline: true },
    linkUrl: { color: 'gray', dimColor: true },
    code: { backgroundColor: 'gray' },
    codeBlock: { backgroundColor: 'gray' },
    codeBlockBorder: { color: 'gray', dimColor: true },
    quote: { italic: true, dimColor: true },
    quoteBorder: { color: 'magenta' },
    hr: { dimColor: true },
    listBullet: { color: 'yellow' },
    bold: { bold: true },
    italic: { italic: true },
    strikethrough: { strikethrough: true },
    underline: { underline: true },
    codeBlockIndent: '  ',
    highlightCode,
    cacheKeyTag: 'd',
};

/** Color-free fallback theme: semantic styling only, no color/backgroundColor. */
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
