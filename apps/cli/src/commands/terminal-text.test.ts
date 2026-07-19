import * as terminalText from '@mission-control/tui';
import {
    clampTextOffset,
    nextGraphemeOffset,
    padEndToDisplayWidth,
    previousGraphemeOffset,
    segmentTerminalText,
    terminalDisplayWidth,
    terminalOffsetForDisplayColumn,
    truncateTerminalText,
} from '@mission-control/tui';
import { describe, expect, it } from 'vitest';

type TerminalTextWithClip = typeof terminalText & {
    readonly clipTerminalText: (value: string, columns: number) => string;
};

function hasClipTerminalText(value: typeof terminalText): value is TerminalTextWithClip {
    return 'clipTerminalText' in value;
}

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
                const segmentEnds = new Set(
                    segments.reduce((acc, { index, segment }) => {
                        acc.push(index + segment.length);
                        return acc;
                    }, [] as number[]),
                );
                segmentEnds.add(0);
                expect(segmentEnds.has(boundary), `offset ${boundary} is not a grapheme boundary in "${text}"`).toBe(
                    true,
                );
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

    it('snaps interior combining and ZWJ offsets against the full string', () => {
        const value = 'e\u0301👨‍👩‍👧‍👦';

        expect(nextGraphemeOffset(value, 0)).toBe(2);
        expect(nextGraphemeOffset(value, 1)).toBe(2);
        expect(nextGraphemeOffset(value, 2)).toBe(13);
        expect(nextGraphemeOffset(value, 7)).toBe(13);
        expect(previousGraphemeOffset(value, 1)).toBe(0);
        expect(previousGraphemeOffset(value, 2)).toBe(0);
        expect(previousGraphemeOffset(value, 7)).toBe(2);
        expect(previousGraphemeOffset(value, 13)).toBe(2);
        expect(terminalOffsetForDisplayColumn(value, 0)).toBe(0);
        expect(terminalOffsetForDisplayColumn(value, 1)).toBe(2);
        expect(terminalOffsetForDisplayColumn(value, 2)).toBe(2);
        expect(terminalOffsetForDisplayColumn(value, 3)).toBe(13);
    });
});

describe('truncateTerminalText', () => {
    it('returns the input unchanged when it fits the column budget', () => {
        expect(truncateTerminalText('abc', 5)).toBe('abc');
        expect(truncateTerminalText('', 5)).toBe('');
    });

    it('uses the default ~ marker when truncating ASCII', () => {
        expect(truncateTerminalText('hello world', 8)).toBe('hello w~');
    });

    it('honours a custom marker', () => {
        expect(truncateTerminalText('hello world', 8, '\u2026')).toBe('hello w\u2026');
        // Empty marker: the full column budget is available for content.
        expect(truncateTerminalText('hello world', 8, '')).toBe('hello wo');
    });

    it('returns just the marker when the column budget equals marker width', () => {
        expect(truncateTerminalText('abc', 1)).toBe('~');
        expect(truncateTerminalText('abc', 1, '\u2026')).toBe('\u2026');
    });

    it('truncates Korean Hangul by visible width, not code-unit count', () => {
        const korean = '\ud55c\uad6d\uc5b4';
        expect(truncateTerminalText(korean, 6)).toBe(korean);
        // Budget 5: marker is 1 col, leaving 4 cols of content = two Hangul (2 each).
        expect(truncateTerminalText(korean, 5)).toBe(`\ud55c\uad6d~`);
        // Budget 4 with ellipsis (1 col): content budget is 3 cols. Two Hangul
        // would need 4 cols, so only one fits.
        expect(truncateTerminalText(korean, 4, '\u2026')).toBe(`\ud55c\u2026`);
        // Budget 3: content budget 2 cols = exactly one Hangul.
        expect(truncateTerminalText(korean, 3)).toBe(`\ud55c~`);
    });

    it('does not split surrogate-pair emoji when truncating', () => {
        const emoji = '\ud83d\ude42';
        const text = `a${emoji}bc`;
        // Budget 2: 'a' (1 col) + marker (1 col); emoji never split.
        expect(truncateTerminalText(text, 2)).toBe('a~');
        // Budget 3: content 2 cols fits 'a' only (emoji is 2 cols, total 3 > 2).
        expect(truncateTerminalText(text, 3)).toBe('a~');
        // Budget 4: content 3 cols fits 'a' + emoji exactly.
        expect(truncateTerminalText(text, 4)).toBe(`a${emoji}~`);
    });

    it('omits an oversized marker and clips normalized column budgets safely', () => {
        expect(truncateTerminalText('abc', 1, '🙂')).toBe('a');
        expect(truncateTerminalText('abc', 0, '~')).toBe('');
        expect(truncateTerminalText('abc', 1.9, '~')).toBe('~');
    });

    it('exports grapheme-safe clipping through the public terminal text surface', () => {
        expect(hasClipTerminalText(terminalText)).toBe(true);
        if (!hasClipTerminalText(terminalText)) return;

        expect(terminalText.clipTerminalText('e\u0301🙂', 1)).toBe('e\u0301');
        expect(terminalText.clipTerminalText('🙂a', 1)).toBe('');
        expect(terminalText.clipTerminalText('abc', 1.9)).toBe('a');
    });
});

describe('padEndToDisplayWidth', () => {
    it('returns the input unchanged when already at or beyond the target width', () => {
        expect(padEndToDisplayWidth('abc', 3)).toBe('abc');
        expect(padEndToDisplayWidth('abcde', 3)).toBe('abcde');
    });

    it('right-pads short ASCII to the target visible width', () => {
        expect(padEndToDisplayWidth('abc', 6)).toBe('abc   ');
    });

    it('pads Korean by visible width, not code-unit count', () => {
        // One Hangul syllable: visible width 2, JS .length 1.
        const korean = '\ud55c';
        // Pad to column 5: 2 (Hangul) + 3 spaces = visible width 5.
        expect(padEndToDisplayWidth(korean, 5)).toBe(`${korean}   `);
        expect(terminalDisplayWidth(padEndToDisplayWidth(korean, 5))).toBe(5);
        // Pad three Hangul (visible width 6) to 10: needs 4 spaces.
        expect(padEndToDisplayWidth('\ud55c\uad6d\uc5b4', 10)).toBe('\ud55c\uad6d\uc5b4    ');
    });

    it('does not pad past the target when the input contains a wide emoji', () => {
        const emoji = '\ud83d\ude42'; // width 2
        expect(padEndToDisplayWidth(`a${emoji}`, 5)).toBe(`a${emoji}  `);
        expect(terminalDisplayWidth(padEndToDisplayWidth(`a${emoji}`, 5))).toBe(5);
    });
});
