import type { TerminalTextStyle } from './theme.js';

export type InlineRun = {
    readonly text: string;
    readonly style: TerminalTextStyle;
    readonly href?: string;
};

export type RenderLine = readonly InlineRun[];
export type RenderBlock = { readonly lines: readonly RenderLine[] };

export function buildOsc8Hyperlink(href: string, text: string): string {
    return `\x1B]8;;${href}\x1B\\${text}\x1B]8;;\x1B\\`;
}

export function stripMailto(href: string): string {
    return href.startsWith('mailto:') ? href.slice(7) : href;
}

export function linkFallbackSuffix(href: string, text: string): string {
    const comparable = stripMailto(href);
    return text === href || text === comparable ? '' : ` (${href})`;
}

export function classifyHeading(depth: number): { readonly style: TerminalTextStyle; readonly prefix: string } {
    return {
        style: { bold: true, ...(depth === 1 ? { underline: true } : {}) },
        prefix: depth >= 3 ? `${'#'.repeat(depth)} ` : '',
    };
}

export function listItemMarker(options: {
    readonly ordered: boolean;
    readonly start: number;
    readonly index: number;
    readonly task: boolean;
    readonly checked: boolean;
}): string {
    const bullet = options.ordered ? `${options.start + options.index}. ` : '- ';
    return options.task ? `${bullet}[${options.checked ? 'x' : ' '}] ` : bullet;
}

export function textRun(text: string, style: TerminalTextStyle): InlineRun {
    return { text, style };
}
