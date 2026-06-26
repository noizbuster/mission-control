/**
 * Pure decoders from opentui {@link TextChunk} styling into the Ink-style
 * {@link InkTextStyle} / {@link HighlightedSpan} shapes the markdown renderer
 * consumes.
 *
 * These functions operate on plain data only. They never touch the opentui
 * native renderer, workers, or {@link SyntaxStyle} — only the packed
 * `attributes` integer, the optional `fg`/`bg` {@link RGBA} values, and the
 * chunk text. Safe to import from any context, including tests.
 *
 * Decode table (opentui base-attribute bit -> InkTextStyle key):
 *
 * | opentui constant              | InkTextStyle key |
 * | ----------------------------- | ---------------- |
 * | `TextAttributes.BOLD`         | `bold`           |
 * | `TextAttributes.DIM`          | `dimColor`       |
 * | `TextAttributes.ITALIC`       | `italic`         |
 * | `TextAttributes.UNDERLINE`    | `underline`      |
 * | `TextAttributes.INVERSE`      | `inverse`        |
 * | `TextAttributes.STRIKETHROUGH`| `strikethrough`  |
 *
 * `TextAttributes.BLINK` and `TextAttributes.HIDDEN` have no Ink equivalent
 * and are deliberately dropped.
 */

import type { RGBA } from '@opentui/core';
import { getBaseAttributes, rgbToHex, TextAttributes } from '@opentui/core';
import type { HighlightedSpan } from './highlight.js';
import type { InkTextStyle } from './theme.js';

/**
 * The color/attribute subset of an opentui {@link TextChunk} this module
 * reads. Structural on purpose so it accepts a real {@link TextChunk} without
 * requiring its `__isChunk`/`link` fields.
 */
type ChunkStyleFields = {
    readonly fg?: RGBA;
    readonly bg?: RGBA;
    readonly attributes?: number;
};

/** A decodeable chunk: text plus the optional color/attribute fields. */
type StylableChunk = {
    readonly text: string;
} & ChunkStyleFields;

/**
 * Decode an opentui packed `attributes` value into an {@link InkTextStyle}.
 *
 * opentui packs the text-attribute bits into the low 8 bits (the base mask);
 * higher bits carry a link id. {@link getBaseAttributes} isolates the base
 * bits so a link-bearing value decodes the same as its base. `undefined`
 * decodes to an empty style. See the file-level table for the bit-to-key map.
 */
export function chunkAttributesToInkStyle(attributes: number | undefined): InkTextStyle {
    const base = getBaseAttributes(attributes ?? 0);
    const hasBold = (base & TextAttributes.BOLD) !== 0;
    const hasDim = (base & TextAttributes.DIM) !== 0;
    const hasItalic = (base & TextAttributes.ITALIC) !== 0;
    const hasUnderline = (base & TextAttributes.UNDERLINE) !== 0;
    const hasInverse = (base & TextAttributes.INVERSE) !== 0;
    const hasStrikethrough = (base & TextAttributes.STRIKETHROUGH) !== 0;
    return {
        ...(hasBold ? { bold: true } : {}),
        ...(hasDim ? { dimColor: true } : {}),
        ...(hasItalic ? { italic: true } : {}),
        ...(hasUnderline ? { underline: true } : {}),
        ...(hasInverse ? { inverse: true } : {}),
        ...(hasStrikethrough ? { strikethrough: true } : {}),
    };
}

/**
 * Decode the color and attribute fields of an opentui chunk into an
 * {@link InkTextStyle}. `fg` maps to `color`, `bg` to `backgroundColor`, both
 * via {@link rgbToHex}; an absent color is omitted rather than set to
 * `undefined`. Attribute flags are merged on top.
 */
export function textChunkToSpanStyle(chunk: ChunkStyleFields): InkTextStyle {
    return {
        ...(chunk.fg !== undefined ? { color: rgbToHex(chunk.fg) } : {}),
        ...(chunk.bg !== undefined ? { backgroundColor: rgbToHex(chunk.bg) } : {}),
        ...chunkAttributesToInkStyle(chunk.attributes),
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
