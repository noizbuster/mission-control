/**
 * Ink-to-opentui type mappings.
 *
 * Ink uses named colors (`'red'`, `'green'`, `'cyan'`) and background
 * (`bgColor`). opentui uses hex strings (`'#ff0000'`). These pure functions
 * bridge the two so that migrated components can accept the same Ink style
 * descriptors from {@link InkTextStyle} and convert them to opentui props.
 *
 * No side effects, no I/O — safe to unit-test without a TTY.
 */

/** Map Ink named colors to opentui hex strings. Covers the 16-color ANSI set. */
export const INK_TO_OPENTUI_COLOR: Readonly<Record<string, string>> = {
    black: '#000000',
    red: '#ff0000',
    green: '#00ff00',
    yellow: '#ffff00',
    blue: '#0000ff',
    magenta: '#ff00ff',
    cyan: '#00ffff',
    white: '#ffffff',
    gray: '#808080',
    grey: '#808080',
    grayBright: '#c0c0c0',
    greyBright: '#c0c0c0',
    redBright: '#ff5555',
    greenBright: '#55ff55',
    yellowBright: '#ffff55',
    blueBright: '#5555ff',
    magentaBright: '#ff55ff',
    cyanBright: '#55ffff',
    whiteBright: '#ffffff',
    dim: '#808080',
};

/**
 * Convert an Ink color (named or hex) to an opentui hex string.
 * Returns `undefined` for `undefined` input (transparent/unset).
 * Unknown named colors pass through unchanged (opentui may still resolve them).
 */
export function toOpenTuiColor(inkColor: string | undefined): string | undefined {
    if (inkColor === undefined) return undefined;
    if (inkColor.startsWith('#')) return inkColor;
    return INK_TO_OPENTUI_COLOR[inkColor] ?? inkColor;
}

/** Map Ink border styles to opentui border styles. */
export const INK_TO_OPENTUI_BORDER: Readonly<Record<string, string>> = {
    single: 'single',
    round: 'rounded',
    rounded: 'rounded',
    double: 'double',
    bold: 'bold',
};

/** Convert an Ink border style to an opentui border style. Passes through unknown styles. */
export function toOpenTuiBorderStyle(inkBorder: string | undefined): string | undefined {
    if (inkBorder === undefined) return undefined;
    return INK_TO_OPENTUI_BORDER[inkBorder] ?? inkBorder;
}

/** opentui text-attribute descriptor (mirrors Ink's boolean style flags). */
export interface OpenTuiTextAttributes {
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly dim?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
    readonly inverse?: boolean;
}

/** Input shape: the subset of Ink `<Text>` style props that map to opentui attributes. */
export interface InkStyleInput {
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly dimColor?: boolean;
    readonly underline?: boolean;
    readonly strikethrough?: boolean;
    readonly inverse?: boolean;
}

/**
 * Map Ink text attributes to opentui text attributes.
 * Ink's `dimColor` maps to opentui's `dim`.
 * Only truthy flags appear in the result (conditional spreads honor `exactOptionalPropertyTypes`).
 */
export function toOpenTuiAttributes(inkStyle: InkStyleInput): OpenTuiTextAttributes {
    return {
        ...(inkStyle.bold === true ? { bold: true } : {}),
        ...(inkStyle.italic === true ? { italic: true } : {}),
        ...(inkStyle.dimColor === true ? { dim: true } : {}),
        ...(inkStyle.underline === true ? { underline: true } : {}),
        ...(inkStyle.strikethrough === true ? { strikethrough: true } : {}),
        ...(inkStyle.inverse === true ? { inverse: true } : {}),
    };
}
