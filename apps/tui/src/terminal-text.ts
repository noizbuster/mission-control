/**
 * Pure terminal text width / grapheme / truncation helpers shared by the CLI
 * noninteractive renderers and the OpenTUI TUI. No React, no opentui, no
 * node:ffi — uses the standard `Intl.Segmenter` with a targeted no-dependency
 * fallback. Extracted from the CLI app so both packages compile during the
 * component move (Todo 4).
 */

import { fallbackSegmentTerminalText, type TerminalTextSegment } from './terminal-grapheme-fallback';

type TextSegment = TerminalTextSegment;

type IntlSegmenter = {
    segment(value: string): Iterable<TextSegment>;
};

const graphemeSegmenter = createGraphemeSegmenter();
const combiningMarkRegex = /\p{Mark}/u;

export function segmentTerminalText(value: string): readonly TextSegment[] {
    if (value.length === 0) {
        return [];
    }
    return graphemeSegmenter === undefined ? fallbackSegmentTerminalText(value) : [...graphemeSegmenter.segment(value)];
}

export function previousGraphemeOffset(value: string, cursorOffset: number): number {
    const offset = clampTextOffset(value, cursorOffset);
    if (offset === 0) {
        return 0;
    }
    const segments = segmentTerminalText(value);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        if (segment !== undefined && segment.index < offset) {
            return segment.index;
        }
    }
    return 0;
}

export function nextGraphemeOffset(value: string, cursorOffset: number): number {
    const offset = clampTextOffset(value, cursorOffset);
    if (offset >= value.length) {
        return value.length;
    }
    for (const segment of segmentTerminalText(value)) {
        const end = segment.index + segment.segment.length;
        if (end > offset) {
            return end;
        }
    }
    return value.length;
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

export function clipTerminalText(value: string, columns: number): string {
    const limit = normalizeTerminalColumns(columns);
    let result = '';
    let width = 0;
    for (const { segment } of segmentTerminalText(value)) {
        const nextWidth = terminalGraphemeWidth(segment);
        if (width + nextWidth > limit) {
            break;
        }
        result += segment;
        width += nextWidth;
    }
    return result;
}

export function truncateTerminalText(value: string, columns: number, marker: string = '~'): string {
    const limit = normalizeTerminalColumns(columns);
    if (terminalDisplayWidth(value) <= limit) {
        return value;
    }
    const markerWidth = terminalDisplayWidth(marker);
    if (markerWidth > limit) {
        return clipTerminalText(value, limit);
    }
    return `${clipTerminalText(value, limit - markerWidth)}${marker}`;
}

export function padEndToDisplayWidth(text: string, width: number): string {
    const textWidth = terminalDisplayWidth(text);
    if (textWidth >= width) {
        return text;
    }
    return `${text}${' '.repeat(width - textWidth)}`;
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

function createGraphemeSegmenter(): IntlSegmenter | undefined {
    const segmenter =
        Intl.Segmenter === undefined ? undefined : new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return segmenter;
}

function normalizeTerminalColumns(columns: number): number {
    return Number.isFinite(columns) ? Math.max(0, Math.trunc(columns)) : 0;
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
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
        (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
        codePoint < 32 ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        combiningMarkRegex.test(character)
    );
}

function isEmojiLike(segment: string): boolean {
    return (
        isKeycapSequence(segment) ||
        segment.includes('\u200d') ||
        segment.includes('\ufe0f') ||
        [...segment].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && codePoint >= 0x1f000 && codePoint <= 0x1faff;
        })
    );
}

function isKeycapSequence(segment: string): boolean {
    return /^[0-9#*]\ufe0f?\u20e3$/u.test(segment);
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
