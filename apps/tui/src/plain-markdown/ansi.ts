import type { TerminalTextStyle } from './theme';

export const TEXT_HIGHLIGHT = '\x1b[96m';
export const TEXT_HIGHLIGHT_BOLD = '\x1b[96m\x1b[1m';
export const TEXT_DIM = '\x1b[90m';
export const TEXT_DIM_BOLD = '\x1b[90m\x1b[1m';
export const TEXT_NORMAL = '\x1b[0m';
export const TEXT_NORMAL_BOLD = '\x1b[1m';
export const TEXT_WARNING = '\x1b[93m';
export const TEXT_WARNING_BOLD = '\x1b[93m\x1b[1m';
export const TEXT_DANGER = '\x1b[91m';
export const TEXT_DANGER_BOLD = '\x1b[91m\x1b[1m';
export const TEXT_SUCCESS = '\x1b[92m';
export const TEXT_SUCCESS_BOLD = '\x1b[92m\x1b[1m';
export const TEXT_INFO = '\x1b[94m';
export const TEXT_INFO_BOLD = '\x1b[94m\x1b[1m';
export const RESET = '\x1b[0m';

const hexRgb = /^#([0-9a-fA-F]{6})$/u;

type Rgb = { readonly r: number; readonly g: number; readonly b: number };

export function sgr(code: number): string {
    return `\x1b[${code}m`;
}

export function wrap(text: string, open: string): string {
    return open === '' ? text : `${open}${text}${RESET}`;
}

function hexToRgb(hex: string): Rgb | undefined {
    if (!hexRgb.test(hex)) return undefined;
    return {
        r: Number.parseInt(hex.slice(1, 3), 16),
        g: Number.parseInt(hex.slice(3, 5), 16),
        b: Number.parseInt(hex.slice(5, 7), 16),
    };
}

function colorOpen(layer: 'fg' | 'bg', rgb: Rgb): string {
    return `\x1b[${layer === 'fg' ? '38;2' : '48;2'};${rgb.r};${rgb.g};${rgb.b}m`;
}

export function terminalTextStyleToAnsi(style: TerminalTextStyle, colorize: boolean): string {
    if (!colorize) return '';
    let open = '';
    if (style.bold) open += sgr(1);
    if (style.dim) open += sgr(2);
    if (style.italic) open += sgr(3);
    if (style.underline) open += sgr(4);
    if (style.strikethrough) open += sgr(9);
    if (style.inverse) open += sgr(7);
    const foreground = style.fg === undefined ? undefined : hexToRgb(style.fg);
    const background = style.bg === undefined ? undefined : hexToRgb(style.bg);
    if (foreground !== undefined) open += colorOpen('fg', foreground);
    if (background !== undefined) open += colorOpen('bg', background);
    return open;
}
