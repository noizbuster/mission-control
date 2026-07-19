import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTtyState } from './run-agent-chat-test-support';
import {
    formatSessionTitle,
    setTerminalTitle,
    suppressTitleManagement,
    TERMINAL_TITLE_SET_PREFIX,
    TERMINAL_TITLE_SET_SUFFIX,
} from './terminal-controls';

afterEach(() => {
    suppressTitleManagement(false);
    vi.restoreAllMocks();
});

describe('terminal title payload sanitization', () => {
    it('keeps canonical title bytes raw while emitting one safe single-line OSC payload', () => {
        // Given
        const restoreTtyState = setTtyState({ input: true, output: true });
        const stderrWrites: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
            stderrWrites.push(String(chunk));
            return true;
        });
        const rawTitle =
            '한국어 👨‍👩‍👧\nsecret sk-titlepayload123 OSC:\u001b]2;owned\u0007 C1:\u009b CR:\r TAB:\t BIDI:\u202e';
        const canonicalTitle = formatSessionTitle('session-fallback', rawTitle);

        try {
            // When
            const written = setTerminalTitle(canonicalTitle);

            // Then
            const expectedPayload =
                '한국어 👨‍👩‍👧\\u{000A}secret [REDACTED_CREDENTIAL] OSC:\\u{001B}]2;owned\\u{0007} C1:\\u{009B} CR:\\u{000D} TAB:\\u{0009} BIDI:\\u{202E}';
            expect(written).toBe(true);
            expect(canonicalTitle).toBe(rawTitle);
            expect(stderrWrites).toEqual([
                `${TERMINAL_TITLE_SET_PREFIX}${expectedPayload}${TERMINAL_TITLE_SET_SUFFIX}`,
            ]);
        } finally {
            restoreTtyState();
        }
    });
});
