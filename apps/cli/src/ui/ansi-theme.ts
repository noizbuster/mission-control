/**
 * ANSI SGR escape constants and the single bridge that maps the repo's
 * `TerminalMarkdownTheme` element styles to ANSI open sequences.
 *
 * The SGR constants mirror opencode's `UI.Style` (see
 * `temp/ref-repos/opencode/.../cli/ui.ts`). The theme type flowing through the
 * whole block pipeline is the REPO's existing `TerminalMarkdownTheme`
 * (`apps/cli/src/components/markdown/theme.ts`); this module introduces NO new
 * theme type. The one exported bridge is `terminalTextStyleToAnsi`.
 *
 * SGR reference:
 *   0 reset, 1 bold, 2 dim, 3 italic, 4 underline, 7 inverse, 9 strikethrough.
 *   Foreground truecolor: `38;2;R;G;B`. Background truecolor: `48;2;R;G;B`.
 */

import type { TerminalTextStyle } from '../components/markdown/theme.js';

// --- SGR escape constants (mirror opencode UI.Style) ------------------------

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

// --- Pure helpers -----------------------------------------------------------

/** Build a CSI Select Graphic Rendition sequence: `sgr(1)` -> `\x1b[1m`. */
export function sgr(code: number): string {
    return `\x1b[${code}m`;
}

/**
 * Wrap `text` in an SGR open sequence and a trailing RESET. When `open` is the
 * empty string the text is returned unchanged so callers can pass a
 * colorize-gated open through unconditionally.
 */
export function wrap(text: string, open: string): string {
    if (open === '') return text;
    return `${open}${text}${RESET}`;
}

// --- terminalTextStyleToAnsi bridge -----------------------------------------

const HEX_RGB_RE = /^#([0-9a-fA-F]{6})$/;

type Rgb = { readonly r: number; readonly g: number; readonly b: number };

/** Parse a `#RRGGBB` hex string into decimal RGB. Returns undefined if malformed. */
function hexToRgb(hex: string): Rgb | undefined {
    if (!HEX_RGB_RE.test(hex)) return undefined;
    return {
        r: Number.parseInt(hex.slice(1, 3), 16),
        g: Number.parseInt(hex.slice(3, 5), 16),
        b: Number.parseInt(hex.slice(5, 7), 16),
    };
}

function truecolorOpen(layer: 'fg' | 'bg', rgb: Rgb): string {
    const prefix = layer === 'fg' ? '38;2' : '48;2';
    return `\x1b[${prefix};${rgb.r};${rgb.g};${rgb.b}m`;
}

/** True when the style carries no effective styling flag. */
function styleIsEmpty(style: TerminalTextStyle): boolean {
    return (
        style.fg === undefined &&
        style.bg === undefined &&
        style.bold !== true &&
        style.dim !== true &&
        style.italic !== true &&
        style.inverse !== true &&
        style.underline !== true &&
        style.strikethrough !== true
    );
}

/**
 * Map a `TerminalTextStyle` (a `TerminalMarkdownTheme` element style) to an SGR
 * open string. Returns `''` when `colorize === false` OR when the style has no
 * effective flag, so callers can pass the result straight to `wrap` and emit no
 * escape at all when color is off. Malformed `fg`/`bg` hex is dropped silently
 * (its segment contributes nothing); it never throws.
 *
 * Concatenation order: bold, dim, italic, underline, strikethrough, inverse,
 * then fg truecolor, then bg truecolor.
 */
export function terminalTextStyleToAnsi(style: TerminalTextStyle, colorize: boolean): string {
    if (!colorize || styleIsEmpty(style)) return '';
    let open = '';
    if (style.bold) open += sgr(1);
    if (style.dim) open += sgr(2);
    if (style.italic) open += sgr(3);
    if (style.underline) open += sgr(4);
    if (style.strikethrough) open += sgr(9);
    if (style.inverse) open += sgr(7);
    if (style.fg !== undefined) {
        const rgb = hexToRgb(style.fg);
        if (rgb !== undefined) open += truecolorOpen('fg', rgb);
    }
    if (style.bg !== undefined) {
        const rgb = hexToRgb(style.bg);
        if (rgb !== undefined) open += truecolorOpen('bg', rgb);
    }
    return open;
}
