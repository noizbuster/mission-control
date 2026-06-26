/**
 * Pure converters between opentui {@link TextChunk} styling and the native
 * {@link TerminalTextStyle} / {@link HighlightedSpan} shapes the markdown
 * renderer consumes.
 *
 * Decoders map opentui's packed `attributes` integer (plus optional `fg`/`bg`
 * {@link RGBA} values) into the flat {@link TerminalTextStyle} form.
 * {@link terminalStyleToTextProps} is the inverse encoder, folding a
 * {@link TerminalTextStyle} back into the `fg`/`bg`/numeric-`attributes` props
 * opentui's `<text>` intrinsic consumes.
 *
 * These functions operate on plain data only. They never touch the opentui
 * native renderer, workers, or {@link SyntaxStyle}. Safe to import from any
 * context, including tests.
 */

import type { RGBA } from '@opentui/core';
import { createTextAttributes, getBaseAttributes, rgbToHex, TextAttributes } from '@opentui/core';
import type { HighlightedSpan } from './highlight.js';
import type { TerminalTextStyle } from './theme.js';

type ChunkStyleFields = {
    readonly fg?: RGBA;
    readonly bg?: RGBA;
    readonly attributes?: number;
};

type StylableChunk = {
    readonly text: string;
} & ChunkStyleFields;

/**
 * Decode an opentui packed `attributes` value into a {@link TerminalTextStyle}.
 * Each set base-attribute bit becomes a flat boolean flag. `undefined` or zero
 * decodes to an empty style. `TextAttributes.BLINK` and `TextAttributes.HIDDEN`
 * have no style equivalent and are deliberately dropped.
 */
export function chunkAttributesToStyle(attributes: number | undefined): TerminalTextStyle {
    const base = getBaseAttributes(attributes ?? 0);
    const flags: {
        bold?: boolean;
        dim?: boolean;
        italic?: boolean;
        underline?: boolean;
        inverse?: boolean;
        strikethrough?: boolean;
    } = {};
    if ((base & TextAttributes.BOLD) !== 0) flags.bold = true;
    if ((base & TextAttributes.DIM) !== 0) flags.dim = true;
    if ((base & TextAttributes.ITALIC) !== 0) flags.italic = true;
    if ((base & TextAttributes.UNDERLINE) !== 0) flags.underline = true;
    if ((base & TextAttributes.INVERSE) !== 0) flags.inverse = true;
    if ((base & TextAttributes.STRIKETHROUGH) !== 0) flags.strikethrough = true;
    return flags;
}

/**
 * Decode the color and attribute fields of an opentui chunk into a
 * {@link TerminalTextStyle}. `fg` maps to the foreground hex, `bg` to the
 * background hex, both via {@link rgbToHex}; an absent color is omitted rather
 * than set to `undefined`. Attribute flags are merged via the nested
 * `attributes` object.
 */
export function textChunkToSpanStyle(chunk: ChunkStyleFields): TerminalTextStyle {
    return {
        ...(chunk.fg !== undefined ? { fg: rgbToHex(chunk.fg) } : {}),
        ...(chunk.bg !== undefined ? { bg: rgbToHex(chunk.bg) } : {}),
        ...chunkAttributesToStyle(chunk.attributes),
    };
}

/**
 * Decode an opentui chunk into a {@link HighlightedSpan}: the chunk's text
 * paired with its decoded style. This is the per-chunk entry point the
 * markdown renderer calls when flattening opentui chunks into styled spans.
 */
export function textChunkToSpan(chunk: StylableChunk): HighlightedSpan {
    return { text: chunk.text, style: textChunkToSpanStyle(chunk) };
}

/** Props opentui's `<text>` intrinsic consumes for styling. */
export type OpenTuiTextProps = {
    readonly fg?: string;
    readonly bg?: string;
    readonly attributes?: number;
};

/**
 * Encode a {@link TerminalTextStyle} into the props opentui's `<text>`
 * intrinsic consumes: `fg`/`bg` pass through as hex, and the boolean flags
 * (both the flat top-level props and any nested `attributes` object) fold into
 * a single numeric `attributes` bitmask via {@link createTextAttributes}.
 * Omitted fields are absent rather than `undefined`, so the result is safe to
 * spread onto `<text>` under `exactOptionalPropertyTypes`. This is the bridge
 * between the markdown IR's {@link TerminalTextStyle} and the actual render.
 */
export function terminalStyleToTextProps(style: TerminalTextStyle): OpenTuiTextProps {
    const flags: {
        bold?: boolean;
        dim?: boolean;
        italic?: boolean;
        underline?: boolean;
        inverse?: boolean;
        strikethrough?: boolean;
    } = {};
    if (style.bold === true) flags.bold = true;
    if (style.dim === true) flags.dim = true;
    if (style.italic === true) flags.italic = true;
    if (style.underline === true) flags.underline = true;
    if (style.inverse === true) flags.inverse = true;
    if (style.strikethrough === true) flags.strikethrough = true;
    const nested = style.attributes;
    if (nested !== undefined) {
        if (nested.bold === true) flags.bold = true;
        if (nested.dim === true) flags.dim = true;
        if (nested.italic === true) flags.italic = true;
        if (nested.underline === true) flags.underline = true;
        if (nested.inverse === true) flags.inverse = true;
        if (nested.strikethrough === true) flags.strikethrough = true;
    }
    const bitmask = createTextAttributes(flags);
    return {
        ...(style.fg !== undefined ? { fg: style.fg } : {}),
        ...(style.bg !== undefined ? { bg: style.bg } : {}),
        ...(bitmask !== 0 ? { attributes: bitmask } : {}),
    };
}
