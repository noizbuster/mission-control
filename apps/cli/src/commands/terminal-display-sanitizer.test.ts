import type { ToolCall } from '@mission-control/protocol';
import type { TranscriptPart } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';
import { emitTranscriptFallback, emitTranscriptPart } from './interactive-transcript-emission';
import { createBufferedChatOutput } from './run-agent-chat-test-support';

const forbiddenTerminalCodePoint = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

type TranscriptWrite = { readonly part: TranscriptPart; readonly fallbackText: string };

describe('terminal display sanitizer', () => {
    // biome-ignore format: The fixture is an exhaustive 13-variant canonical-byte contract matrix.
    it('passes every specialized transcript field and identity metadata byte-exact', () => {
        // Given
        const recording = createRecordingOutput();
        const unsafe = '안녕 👩‍💻\nsecret sk-canonicalmatrix123 CSI:\u001b[31m OSC:\u001b]52;c;payload\u0007 C1:\u009b CR:\r TAB:\t DEL:\u007f BIDI:\u202e';
        const rawIdentity = 'identity\u001b[31m';
        const parts = [
            { id: 'user-id', type: 'user', text: unsafe },
            { id: rawIdentity, type: 'assistant', text: unsafe, title: unsafe, detail: unsafe, error: unsafe, status: 'streaming', requestId: rawIdentity, messageId: rawIdentity },
            { id: 'reasoning-id', type: 'reasoning', text: unsafe, status: 'completed', requestId: 'reasoning-request-raw', messageId: 'reasoning-message-raw' },
            { id: 'inline-tool-id', type: 'inline-tool', text: unsafe, toolName: unsafe, output: unsafe, appliedFiles: [unsafe, 'safe.ts'], status: 'failed', toolCallId: rawIdentity },
            { id: 'block-tool-id', type: 'block-tool', text: unsafe, toolName: unsafe, output: unsafe, status: 'completed', toolCallId: 'block-call-raw' },
            { id: 'diff-id', type: 'diff', text: unsafe, filePath: unsafe, status: 'pending', toolCallId: 'diff-call-raw' },
            { id: 'code-id', type: 'code', text: unsafe, filePath: unsafe, language: unsafe, status: 'streaming' },
            { id: 'command-id', type: 'command', text: unsafe, command: unsafe, exitCode: 7, status: 'completed', toolCallId: 'command-call-raw' },
            { id: 'subagent-id', type: 'subagent', text: unsafe, agentName: unsafe, sessionId: unsafe, status: 'background', toolCallId: 'subagent-call-raw' },
            { id: 'status-id', type: 'status', text: unsafe, title: unsafe, detail: unsafe, error: unsafe, status: 'running' },
            { id: 'event-id', type: 'event', text: unsafe, eventId: rawIdentity, eventType: unsafe, timestamp: unsafe, status: 'informational' },
            { id: 'error-id', type: 'error', text: unsafe, error: unsafe, code: unsafe, status: 'failed' },
            { id: 'legacy-id', type: 'legacy', text: unsafe },
        ] satisfies readonly TranscriptPart[];

        // When
        for (const part of parts) emitTranscriptPart(recording.output, part, unsafe);

        // Then
        expect(recording.writes.map(({ part }) => part)).toEqual(parts);
        expect(recording.writes.every(({ part }, index) => part === parts[index])).toBe(true);
        expect(recording.writes.map(({ fallbackText }) => Buffer.from(fallbackText))).toEqual(
            parts.map(() => Buffer.from(unsafe)),
        );
        expect(parts.every((part) => part.text === unsafe)).toBe(true);
    });

    it('passes specialized fallback credentials, controls, Unicode, ZWJ, and LF bytes unchanged', () => {
        // Given
        const specializedWrites: string[] = [];
        const text = '한국어 👨‍👩‍👧\nsecret sk-canonicalfallback123\u0001\u001b]52;c;payload\u0007\u009b\u007f\u202e';

        // When
        emitTranscriptFallback(
            {
                write: () => undefined,
                writeTranscriptFallback: (value) => specializedWrites.push(value),
            },
            text,
        );

        // Then
        expect(specializedWrites).toEqual([text]);
        expect(Buffer.from(specializedWrites[0] ?? '')).toEqual(Buffer.from(text));
    });

    it('escapes every forbidden C0, DEL, C1, and bidi code point in emitted bytes', () => {
        // Given
        const writes: string[] = [];
        const codePoints = [
            ...Array.from({ length: 10 }, (_, index) => index),
            ...Array.from({ length: 21 }, (_, index) => index + 0x0b),
            ...Array.from({ length: 33 }, (_, index) => index + 0x7f),
            0x061c,
            0x200e,
            0x200f,
            ...Array.from({ length: 5 }, (_, index) => index + 0x202a),
            ...Array.from({ length: 4 }, (_, index) => index + 0x2066),
        ];
        const unsafe = codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join('');

        // When
        emitTranscriptFallback({ write: (text) => writes.push(text) }, unsafe);

        // Then
        const expected = codePoints
            .map((codePoint) => `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`)
            .join('');
        expect(writes).toEqual([expected]);
        expect(Buffer.from(writes.join(''))).toEqual(Buffer.from(expected));
        expect(writes.join('')).not.toMatch(forbiddenTerminalCodePoint);
    });

    it('redacts and escapes both plain write branches while preserving LF, Unicode, and ZWJ', () => {
        // Given
        const plainWrites: string[] = [];
        const unsafe = '한국어 👨‍👩‍👧\nsecret sk-plainfallback123 C0:\u0001 TAB:\t C1:\u009b DEL:\u007f BIDI:\u202e';

        // When
        emitTranscriptFallback({ write: (text) => plainWrites.push(text) }, unsafe);
        emitTranscriptPart(
            { write: (text) => plainWrites.push(text) },
            { id: 'plain-assistant', type: 'assistant', text: unsafe },
            unsafe,
        );

        // Then
        const expected =
            '한국어 👨‍👩‍👧\nsecret [REDACTED_CREDENTIAL] C0:\\u{0001} TAB:\\u{0009} C1:\\u{009B} DEL:\\u{007F} BIDI:\\u{202E}';
        expect(plainWrites).toEqual([expected, expected]);
        expect(plainWrites.every((text) => !forbiddenTerminalCodePoint.test(text.replaceAll('\n', '')))).toBe(true);
    });

    it('visibly escapes terminal controls in command and patch previews', async () => {
        // Given
        const output = createBufferedChatOutput();
        const terminalPayload = 'preview\u001b[31m\u0007\u009b\r\t\u202e';
        const state = createProviderRenderState('terminal-sanitizer-test');

        // When
        await renderToolPreview(
            toolCall('command.run', 'command_terminal_preview', { command: 'printf', args: [terminalPayload] }),
            output.output,
            { state },
        );
        await renderToolPreview(
            toolCall('file.patch', 'patch_terminal_preview', {
                patch: [
                    'diff --git a/terminal-preview.txt b/terminal-preview.txt',
                    '--- /dev/null',
                    '+++ b/terminal-preview.txt',
                    '@@ -0,0 +1 @@',
                    `+${terminalPayload}`,
                    '',
                ].join('\n'),
            }),
            output.output,
            { state },
        );

        // Then
        const display = output.getOutput();
        expect(display).toContain('preview\\u{001B}[31m\\u{0007}\\u{009B}\\u{000D}\\u{0009}\\u{202E}');
        expect(display.replaceAll('\n', '')).not.toMatch(forbiddenTerminalCodePoint);
    });
});

function createRecordingOutput(): { readonly output: ChatOutput; readonly writes: TranscriptWrite[] } {
    const writes: TranscriptWrite[] = [];
    return {
        output: {
            write: () => undefined,
            writeTranscriptPart: (part, fallbackText) => writes.push({ part, fallbackText }),
        },
        writes,
    };
}

function toolCall(toolName: string, toolCallId: string, input: Readonly<Record<string, unknown>>): ToolCall {
    return { toolCallId, toolName, argumentsJson: JSON.stringify(input) };
}
