import { describe, expect, it, vi } from 'vitest';
import { createTerminalChatOutput } from './interactive-chat-io';

describe('terminal chat output', () => {
    it('redacts credentials and visibly escapes untrusted terminal controls before writing stdout', () => {
        // Given
        const stdoutWrites: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            stdoutWrites.push(String(chunk));
            return true;
        });
        const output = createTerminalChatOutput();
        const unsafe =
            '한국어 👨‍👩‍👧\nsecret sk-terminaloutput123 OSC:\u001b]52;c;payload\u0007 C1:\u009b CR:\r TAB:\t BIDI:\u202e';

        // When
        output.write(unsafe);

        // Then
        const expected =
            '한국어 👨‍👩‍👧\nsecret [REDACTED_CREDENTIAL] OSC:\\u{001B}]52;c;payload\\u{0007} C1:\\u{009B} CR:\\u{000D} TAB:\\u{0009} BIDI:\\u{202E}';
        expect(stdoutWrites).toEqual([expected]);
        expect(Buffer.from(stdoutWrites[0] ?? '')).toEqual(Buffer.from(expected));
    });
});
