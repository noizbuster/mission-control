import { describe, expect, it } from 'vitest';
import {
    DEFAULT_TERMINAL_VIEWPORT,
    normalizeTerminalViewport,
    type OpenTuiTerminalDimensions,
    type TerminalViewport,
} from './terminal-viewport.js';

type Case = {
    readonly name: string;
    readonly dimensions: OpenTuiTerminalDimensions;
    readonly expected: TerminalViewport;
};

describe('normalizeTerminalViewport', () => {
    const cases: readonly Case[] = [
        {
            name: 'passes through valid width and height as columns/rows',
            dimensions: { width: 120, height: 40 },
            expected: { columns: 120, rows: 40 },
        },
        {
            name: 'falls back when width/height missing',
            dimensions: {},
            expected: DEFAULT_TERMINAL_VIEWPORT,
        },
        {
            name: 'falls back invalid height only',
            dimensions: { width: 100, height: 0 },
            expected: { columns: 100, rows: DEFAULT_TERMINAL_VIEWPORT.rows },
        },
    ];

    for (const testCase of cases) {
        it(testCase.name, () => {
            expect(normalizeTerminalViewport(testCase.dimensions)).toEqual(testCase.expected);
        });
    }
});
