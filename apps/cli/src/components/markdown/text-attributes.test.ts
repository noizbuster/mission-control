import { attributesWithLink, createTextAttributes, RGBA, rgbToHex } from '@opentui/core';
import { describe, expect, it } from 'vitest';
import { chunkAttributesToStyle, textChunkToSpan, textChunkToSpanStyle } from './text-attributes.js';
import type { TerminalTextStyle } from './theme.js';

/**
 * Each opentui base-attribute flag, built via {@link createTextAttributes} so
 * the test never hardcodes bit numbers, paired with the TerminalTextStyle key
 * it must decode to. Attribute bits map 1:1 to style keys.
 */
const ATTRIBUTE_FLAG_CASES = [
    ['bold', () => createTextAttributes({ bold: true })],
    ['dim', () => createTextAttributes({ dim: true })],
    ['italic', () => createTextAttributes({ italic: true })],
    ['underline', () => createTextAttributes({ underline: true })],
    ['inverse', () => createTextAttributes({ inverse: true })],
    ['strikethrough', () => createTextAttributes({ strikethrough: true })],
] as const satisfies ReadonlyArray<readonly [keyof TerminalTextStyle, () => number]>;

describe('chunkAttributesToStyle', () => {
    for (const [key, makeAttrs] of ATTRIBUTE_FLAG_CASES) {
        it(`decodes the ${key} attribute bit to ${key}: true and no other key`, () => {
            const style = chunkAttributesToStyle(makeAttrs());
            expect(style).toStrictEqual({ [key]: true });
        });
    }

    it('returns an empty style when attributes is undefined', () => {
        expect(chunkAttributesToStyle(undefined)).toStrictEqual({});
    });

    it('returns an empty style for a zero attribute value', () => {
        expect(chunkAttributesToStyle(0)).toStrictEqual({});
    });

    it('decodes several attribute bits at once', () => {
        const attrs = createTextAttributes({ bold: true, italic: true, underline: true });
        expect(chunkAttributesToStyle(attrs)).toStrictEqual({
            bold: true,
            italic: true,
            underline: true,
        });
    });

    it('drops BLINK and HIDDEN which have no style equivalent', () => {
        const attrs = createTextAttributes({ blink: true, hidden: true });
        expect(chunkAttributesToStyle(attrs)).toStrictEqual({});
    });

    it('ignores link-id bits packed into the upper bytes', () => {
        const withLink = attributesWithLink(createTextAttributes({ bold: true }), 7);
        expect(chunkAttributesToStyle(withLink)).toStrictEqual({ bold: true });
    });
});

describe('textChunkToSpanStyle', () => {
    it('maps a foreground color to a #-prefixed hex fg', () => {
        const style = textChunkToSpanStyle({ fg: RGBA.fromHex('#ff8800') });
        expect(style.fg).toBe('#ff8800');
        expect(style.fg?.startsWith('#')).toBe(true);
    });

    it('omits the fg key entirely when fg is undefined', () => {
        const style = textChunkToSpanStyle({});
        expect(style).toStrictEqual({});
        expect(style.fg).toBeUndefined();
    });

    it('maps a background color to bg', () => {
        const style = textChunkToSpanStyle({ bg: RGBA.fromHex('#112233') });
        expect(style).toStrictEqual({ bg: '#112233' });
    });

    it('combines a foreground color with attribute flags', () => {
        const style = textChunkToSpanStyle({
            fg: RGBA.fromHex('#ff8800'),
            attributes: createTextAttributes({ bold: true }),
        });
        expect(style).toStrictEqual({ fg: '#ff8800', bold: true });
    });
});

describe('textChunkToSpan', () => {
    it('pairs chunk text with its decoded style', () => {
        const span = textChunkToSpan({
            text: 'hi',
            fg: RGBA.fromHex('#ff8800'),
            attributes: createTextAttributes({ bold: true }),
        });
        expect(span).toStrictEqual({ text: 'hi', style: { fg: '#ff8800', bold: true } });
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
