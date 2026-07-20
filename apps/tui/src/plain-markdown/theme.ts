export type TextStyleAttributeFlags = {
    readonly bold?: boolean;
    readonly dim?: boolean;
    readonly italic?: boolean;
    readonly inverse?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
};

export type TerminalTextStyle = TextStyleAttributeFlags & {
    readonly fg?: string;
    readonly bg?: string;
    readonly attributes?: TextStyleAttributeFlags;
};

export type HighlightedSpan = { readonly text: string; readonly style: TerminalTextStyle };
export type HighlightedLine = { readonly spans: readonly HighlightedSpan[] };
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

export function mergeTextStyle(...styles: readonly (TerminalTextStyle | undefined)[]): TerminalTextStyle {
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
        for (const key of ['bold', 'dim', 'italic', 'inverse', 'underline', 'strikethrough'] as const) {
            if (style[key] === true || style.attributes?.[key] === true) flags[key] = true;
        }
    }
    return { ...(fg !== undefined ? { fg } : {}), ...(bg !== undefined ? { bg } : {}), ...flags };
}

export const darkTheme: TerminalMarkdownTheme = {
    heading: { bold: true, fg: '#9d7cd8' },
    link: { fg: '#fab283', underline: true },
    linkUrl: { fg: '#56b6c2', dim: true },
    code: { fg: '#7fd88f' },
    codeBlock: { fg: '#eeeeee' },
    codeBlockBorder: { fg: '#808080', dim: true },
    quote: { italic: true, fg: '#e5c07b' },
    quoteBorder: { fg: '#e5c07b' },
    hr: { dim: true, fg: '#808080' },
    listBullet: { fg: '#fab283' },
    bold: { bold: true, fg: '#f5a742' },
    italic: { italic: true, fg: '#e5c07b' },
    strikethrough: { strikethrough: true, fg: '#808080' },
    underline: { underline: true },
    codeBlockIndent: '  ',
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
