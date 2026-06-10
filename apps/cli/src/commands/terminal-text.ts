type TextSegment = {
    readonly segment: string;
    readonly index: number;
};

type IntlSegmenter = {
    segment(value: string): Iterable<TextSegment>;
};

const graphemeSegmenter = createGraphemeSegmenter();
const combiningMarkRegex = /\p{Mark}/u;

export function segmentTerminalText(value: string): readonly TextSegment[] {
    if (value.length === 0) {
        return [];
    }
    return [...graphemeSegmenter.segment(value)];
}

export function previousGraphemeOffset(value: string, cursorOffset: number): number {
    const offset = clampTextOffset(value, cursorOffset);
    if (offset === 0) {
        return 0;
    }
    const segments = segmentTerminalText(value.slice(0, offset));
    return segments.at(-1)?.index ?? Math.max(0, offset - 1);
}

export function nextGraphemeOffset(value: string, cursorOffset: number): number {
    const offset = clampTextOffset(value, cursorOffset);
    if (offset >= value.length) {
        return value.length;
    }
    const segment = segmentTerminalText(value.slice(offset)).at(0);
    return Math.min(value.length, offset + (segment?.segment.length ?? 1));
}

export function clampTextOffset(value: string, cursorOffset: number): number {
    return Math.min(Math.max(0, cursorOffset), value.length);
}

export function terminalDisplayWidth(value: string): number {
    let width = 0;
    for (const { segment } of segmentTerminalText(value)) {
        width += terminalGraphemeWidth(segment);
    }
    return width;
}

export function truncateTerminalText(value: string, columns: number): string {
    const limit = Math.max(1, columns);
    if (terminalDisplayWidth(value) <= limit) {
        return value;
    }
    if (limit === 1) {
        return '~';
    }
    let result = '';
    let width = 0;
    const contentLimit = limit - 1;
    for (const { segment } of segmentTerminalText(value)) {
        const nextWidth = terminalGraphemeWidth(segment);
        if (width + nextWidth > contentLimit) {
            break;
        }
        result += segment;
        width += nextWidth;
    }
    return `${result}~`;
}

export function terminalOffsetForDisplayColumn(value: string, column: number): number {
    const targetColumn = Math.max(0, column);
    let width = 0;
    for (const { segment, index } of segmentTerminalText(value)) {
        const nextWidth = width + terminalGraphemeWidth(segment);
        if (nextWidth > targetColumn) {
            return index;
        }
        width = nextWidth;
    }
    return value.length;
}

function createGraphemeSegmenter(): IntlSegmenter {
    const segmenter =
        Intl.Segmenter === undefined ? undefined : new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    if (segmenter !== undefined) {
        return segmenter;
    }
    return {
        segment(value: string) {
            const segments: TextSegment[] = [];
            let index = 0;
            for (const segment of Array.from(value)) {
                segments.push({ segment, index });
                index += segment.length;
            }
            return segments;
        },
    };
}

function terminalGraphemeWidth(segment: string): number {
    if (segment.length === 0) {
        return 0;
    }
    if (segment === '\t') {
        return 4;
    }
    if (isEmojiLike(segment)) {
        return 2;
    }
    let width = 0;
    for (const character of segment) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined || isZeroWidthCodePoint(codePoint, character)) {
            continue;
        }
        width += isFullwidthCodePoint(codePoint) ? 2 : 1;
    }
    return width;
}

function isZeroWidthCodePoint(codePoint: number, character: string): boolean {
    return (
        codePoint === 0 ||
        codePoint === 0x200d ||
        codePoint === 0xfe0e ||
        codePoint === 0xfe0f ||
        codePoint < 32 ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        combiningMarkRegex.test(character)
    );
}

function isEmojiLike(segment: string): boolean {
    return (
        segment.includes('\u200d') ||
        segment.includes('\ufe0f') ||
        [...segment].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && codePoint >= 0x1f000 && codePoint <= 0x1faff;
        })
    );
}

function isFullwidthCodePoint(codePoint: number): boolean {
    return (
        codePoint >= 0x1100 &&
        (codePoint <= 0x115f ||
            codePoint === 0x2329 ||
            codePoint === 0x232a ||
            (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
            (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
            (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
            (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
            (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
            (codePoint >= 0xff00 && codePoint <= 0xff60) ||
            (codePoint >= 0xffe0 && codePoint <= 0xffe6))
    );
}
