import { describe, expect, it } from 'vitest';
import {
    clampTextOffset,
    nextGraphemeOffset,
    previousGraphemeOffset,
    segmentTerminalText,
    terminalDisplayWidth,
    terminalOffsetForDisplayColumn,
} from './terminal-text.js';

describe('terminal text display offsets', () => {
    it('segments basic text into grapheme clusters', () => {
        expect(segmentTerminalText('').map(({ segment }) => segment)).toEqual([]);
        expect(segmentTerminalText('abc').map(({ segment }) => segment)).toEqual(['a', 'b', 'c']);
    });

    it('maps Korean fullwidth display columns to safe grapheme offsets', () => {
        const korean = '\ud55c\uad6d\uc5b4';

        expect(terminalDisplayWidth(korean)).toBe(6);

        expect(terminalOffsetForDisplayColumn(korean, 0)).toBe(0);
        expect(terminalOffsetForDisplayColumn(korean, 2)).toBe(1);
        expect(terminalOffsetForDisplayColumn(korean, 4)).toBe(2);
        expect(terminalOffsetForDisplayColumn(korean, 6)).toBe(3);

        // Odd display columns fall inside a fullwidth cell and must round back.
        expect(terminalOffsetForDisplayColumn(korean, 1)).toBe(0);
        expect(terminalOffsetForDisplayColumn(korean, 3)).toBe(1);
        expect(terminalOffsetForDisplayColumn(korean, 5)).toBe(2);
    });

    it('treats emoji ZWJ and combining clusters as one cursor unit', () => {
        const zwjFamily = '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67';

        expect(segmentTerminalText(zwjFamily)).toHaveLength(1);
        expect(terminalDisplayWidth(zwjFamily)).toBe(2);

        const combining = 'e\u0301';

        expect(segmentTerminalText(combining)).toHaveLength(1);
        expect(terminalDisplayWidth(combining)).toBe(1);

        const mixed = `a${zwjFamily}b`;
        expect(nextGraphemeOffset(mixed, 1)).toBe(1 + zwjFamily.length);
        expect(previousGraphemeOffset(mixed, 1 + zwjFamily.length)).toBe(1);

        const combiningText = `a${combining}b`;
        expect(nextGraphemeOffset(combiningText, 1)).toBe(1 + combining.length);
        expect(previousGraphemeOffset(combiningText, 1 + combining.length)).toBe(1);
    });

    it('never returns an offset inside a surrogate pair or combining sequence', () => {
        const emoji = '\ud83d\ude42';
        const text = `a${emoji}b`;

        for (let offset = 0; offset <= text.length; offset += 1) {
            const prev = previousGraphemeOffset(text, offset);
            const next = nextGraphemeOffset(text, offset);

            for (const boundary of [prev, next]) {
                const segments = segmentTerminalText(text.slice(0, boundary));
                const segmentEnds = new Set(segments.reduce((acc, { index, segment }) => {
                    acc.push(index + segment.length);
                    return acc;
                }, [] as number[]));
                segmentEnds.add(0);
                expect(segmentEnds.has(boundary), `offset ${boundary} is not a grapheme boundary in "${text}"`).toBe(true);
            }
        }

        // Surrogate pair: offset 2 is inside 🙂 and must never be returned.
        expect(previousGraphemeOffset(text, 3)).toBe(1);
        expect(nextGraphemeOffset(text, 1)).toBe(3);

        const combining = 'e\u0301';
        const combiningText = `a${combining}b`;

        expect(previousGraphemeOffset(combiningText, 3)).toBe(1);
        expect(nextGraphemeOffset(combiningText, 1)).toBe(3);

        expect(clampTextOffset(text, -1)).toBe(0);
        expect(clampTextOffset(text, 999)).toBe(text.length);
    });
});
