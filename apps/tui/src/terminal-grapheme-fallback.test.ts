import { describe, expect, it } from 'vitest';
import { fallbackSegmentTerminalText } from './terminal-grapheme-fallback';
import { segmentTerminalText, terminalDisplayWidth } from './terminal-text';

function expectScalarSafeSegments(value: string): void {
    const segments = fallbackSegmentTerminalText(value);

    expect(segments.map(({ segment }) => segment).join('')).toBe(value);
    for (const { index, segment } of segments) {
        expect(isScalarBoundary(value, index)).toBe(true);
        expect(isScalarBoundary(value, index + segment.length)).toBe(true);
    }
}

function isScalarBoundary(value: string, index: number): boolean {
    if (index <= 0 || index >= value.length) return true;
    const previous = value.charCodeAt(index - 1);
    const current = value.charCodeAt(index);
    return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

describe('fallbackSegmentTerminalText', () => {
    it('groups the audited combining and family graphemes at UTF-16 offsets', () => {
        const value = 'e\u0301👨‍👩‍👧‍👦';
        const segments = fallbackSegmentTerminalText(value);

        expect(segments).toEqual([
            { segment: 'e\u0301', index: 0 },
            { segment: '👨‍👩‍👧‍👦', index: 2 },
        ]);
        expect(segments.map(({ segment }) => terminalDisplayWidth(segment))).toEqual([1, 2]);
        expectScalarSafeSegments(value);
    });

    it.each([
        ['airplane variation selector', '✈️', ['✈️'], 2],
        ['supplementary variation selector', 'a\u{e0100}', ['a\u{e0100}'], 1],
        ['emoji modifier', '👍🏽', ['👍🏽'], 2],
        ['family ZWJ chain', '👨‍👩‍👧‍👦', ['👨‍👩‍👧‍👦'], 2],
        ['keycap with variation selector', '1️⃣', ['1️⃣'], 2],
        ['keycap without variation selector', '1⃣', ['1⃣'], 2],
        ['CRLF', '\r\n', ['\r\n'], 0],
        ['regional indicator pairs', '🇺🇸🇨🇦', ['🇺🇸', '🇨🇦'], 4],
    ])('keeps %s scalar-safe', (_name, value, expected, width) => {
        expect(fallbackSegmentTerminalText(value).map(({ segment }) => segment)).toEqual(expected);
        expect(terminalDisplayWidth(value)).toBe(width);
        expectScalarSafeSegments(value);
    });

    it('keeps the native segmenter as the public default when it is available', () => {
        if (Intl.Segmenter === undefined) return;

        const value = 'e\u0301👨‍👩‍👧‍👦1️⃣🇺🇸';
        const native = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

        expect(segmentTerminalText(value)).toEqual([...native.segment(value)]);
    });
});
