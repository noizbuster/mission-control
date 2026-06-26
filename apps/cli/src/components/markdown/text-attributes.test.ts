import { attributesWithLink, createTextAttributes, RGBA, rgbToHex } from '@opentui/core';
import { describe, expect, it } from 'vitest';
import { chunkAttributesToInkStyle, textChunkToSpan, textChunkToSpanStyle } from './text-attributes.js';
import type { InkTextStyle } from './theme.js';

/**
 * Each opentui base-attribute flag, built via {@link createTextAttributes} so
 * the test never hardcodes bit numbers, paired with the InkTextStyle key it
 * must decode to. `dim` -> `dimColor` is the one renamed key.
 */
const ATTRIBUTE_FLAG_CASES = [
    ['bold', () => createTextAttributes({ bold: true })],
    ['dimColor', () => createTextAttributes({ dim: true })],
    ['italic', () => createTextAttributes({ italic: true })],
    ['underline', () => createTextAttributes({ underline: true })],
    ['inverse', () => createTextAttributes({ inverse: true })],
    ['strikethrough', () => createTextAttributes({ strikethrough: true })],
] as const satisfies ReadonlyArray<readonly [keyof InkTextStyle, () => number]>;

describe('chunkAttributesToInkStyle', () => {
    for (const [key, makeAttrs] of ATTRIBUTE_FLAG_CASES) {
        it(`decodes the ${key} attribute bit to ${key}: true and no other key`, () => {
            const style = chunkAttributesToInkStyle(makeAttrs());
            expect(style).toStrictEqual({ [key]: true });
        });
    }

    it('returns an empty style when attributes is undefined', () => {
        expect(chunkAttributesToInkStyle(undefined)).toStrictEqual({});
    });

    it('returns an empty style for a zero attribute value', () => {
        expect(chunkAttributesToInkStyle(0)).toStrictEqual({});
    });

    it('decodes several attribute bits at once', () => {
        const attrs = createTextAttributes({ bold: true, italic: true, underline: true });
        expect(chunkAttributesToInkStyle(attrs)).toStrictEqual({
            bold: true,
            italic: true,
            underline: true,
        });
    });

    it('drops BLINK and HIDDEN which have no Ink equivalent', () => {
        const attrs = createTextAttributes({ blink: true, hidden: true });
        expect(chunkAttributesToInkStyle(attrs)).toStrictEqual({});
    });

    it('ignores link-id bits packed into the upper bytes', () => {
        const withLink = attributesWithLink(createTextAttributes({ bold: true }), 7);
        expect(chunkAttributesToInkStyle(withLink)).toStrictEqual({ bold: true });
    });
});

describe('textChunkToSpanStyle', () => {
    it('maps a foreground color to a #-prefixed hex color', () => {
        const style = textChunkToSpanStyle({ fg: RGBA.fromHex('#ff8800') });
        expect(style.color).toBe('#ff8800');
        expect(style.color?.startsWith('#')).toBe(true);
    });

    it('omits the color key entirely when fg is undefined', () => {
        const style = textChunkToSpanStyle({});
        expect(style).toStrictEqual({});
        expect(style.color).toBeUndefined();
    });

    it('maps a background color to backgroundColor', () => {
        const style = textChunkToSpanStyle({ bg: RGBA.fromHex('#112233') });
        expect(style).toStrictEqual({ backgroundColor: '#112233' });
    });

    it('combines a foreground color with attribute flags', () => {
        const style = textChunkToSpanStyle({
            fg: RGBA.fromHex('#ff8800'),
            attributes: createTextAttributes({ bold: true }),
        });
        expect(style).toStrictEqual({ color: '#ff8800', bold: true });
    });
});

describe('textChunkToSpan', () => {
    it('pairs chunk text with its decoded style', () => {
        const span = textChunkToSpan({
            text: 'hi',
            fg: RGBA.fromHex('#ff8800'),
            attributes: createTextAttributes({ bold: true }),
        });
        expect(span).toStrictEqual({ text: 'hi', style: { color: '#ff8800', bold: true } });
    });

    it('yields an empty style for a plain chunk with no styling', () => {
        expect(textChunkToSpan({ text: 'plain' })).toStrictEqual({ text: 'plain', style: {} });
    });
});

describe('rgbToHex round-trip', () => {
    for (const hex of ['#000000', '#ffffff', '#ff8800', '#aabbcc', '#3fa7d8']) {
        it(`round-trips ${hex} through RGBA.fromHex and rgbToHex`, () => {
            expect(rgbToHex(RGBA.fromHex(hex))).toBe(hex);
        });
    }
});
