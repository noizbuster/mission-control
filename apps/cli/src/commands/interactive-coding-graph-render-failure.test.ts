import { afterEach, describe, expect, it, vi } from 'vitest';
import { interactiveGraphStreamSignal } from './interactive-coding-graph-rendering';
import {
    createPlainRecording,
    graphDelta,
    graphFailure,
    renderState,
    turnStarted,
} from './interactive-transcript-fallback-test-support';

const RAW_CONTROL_OR_FORMAT_CODE_POINT = /[\p{Cc}\p{Cf}]/u;

function expectSafeFraming(message: string): void {
    expect(message.endsWith('\n')).toBe(true);
    expect(message.slice(0, -1)).not.toMatch(RAW_CONTROL_OR_FORMAT_CODE_POINT);
}

describe('interactive graph render failure diagnostics', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps stderr render diagnostics on one escaped line', async () => {
        // Given
        const secret = 'sk-rendercontrol123';
        const injectedMessage = `한글 ${secret} ZWJ \u200D LF\nCSI \u001B[31m BEL \u0007 C1 \u009B bidi \u202E`;
        const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const output = {
            write: () => undefined,
            writeTranscriptPart: () => {
                throw new Error(injectedMessage);
            },
        };

        // When
        const tap = interactiveGraphStreamSignal(output, renderState(), '/workspace');
        await tap(turnStarted('render-failure-node', 'turn'));
        await tap(graphDelta('render-failure-node', 'llm.text.delta', 'answer'));

        // Then
        const stderrMessage =
            'Interactive graph render failed: 한글 [REDACTED_CREDENTIAL] ZWJ \\u{200D} LF\\u{000A}CSI \\u{001B}[31m BEL \\u{0007} C1 \\u{009B} bidi \\u{202E}\n';
        expect(stderrWrite).toHaveBeenCalledTimes(1);
        expect(stderrWrite).toHaveBeenCalledWith(stderrMessage);
        expectSafeFraming(stderrMessage);
        expect(stderrMessage).not.toContain(secret);
    });

    it('uses display sanitization for fallback while preserving LF, CJK, and ZWJ', async () => {
        // Given
        const secret = 'sk-renderdisplay123';
        const injectedMessage = `한국어 👨‍👩‍👧\nsecret ${secret} CSI \u001B[31m OSC \u001B]52;c;payload\u0007 BEL \u0007 C1 \u009B31m bidi \u202E`;
        const writes: string[] = [];
        vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const output = {
            write: (text: string) => writes.push(text),
            writeTranscriptPart: () => {
                throw new Error(injectedMessage);
            },
        };

        // When
        const tap = interactiveGraphStreamSignal(output, renderState(), '/workspace');
        await tap(turnStarted('render-display-failure-node', 'turn'));
        await tap(graphDelta('render-display-failure-node', 'llm.text.delta', 'answer'));

        // Then
        const fallbackMessage =
            'Error: 한국어 👨‍👩‍👧\nsecret [REDACTED_CREDENTIAL] CSI \\u{001B}[31m OSC \\u{001B}]52;c;payload\\u{0007} BEL \\u{0007} C1 \\u{009B}31m bidi \\u{202E}\n';
        expect(writes).toEqual([fallbackMessage]);
        expect(fallbackMessage.replaceAll('\n', '').replaceAll('\u200D', '')).not.toMatch(
            RAW_CONTROL_OR_FORMAT_CODE_POINT,
        );
        expect(fallbackMessage).not.toContain(secret);
    });

    it('sanitizes the nested diagnostic when the internal Error fallback write also fails', async () => {
        // Given
        const secret = 'sk-renderwrite123';
        const writeAttempts: string[] = [];
        const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const output = {
            write: (text: string) => {
                writeAttempts.push(text);
                throw new Error(`write failed ${secret}\u0007\n\u2066`);
            },
            writeTranscriptPart: () => {
                throw new Error('preview failed \u001B[31m');
            },
        };

        // When
        const tap = interactiveGraphStreamSignal(output, renderState(), '/workspace');
        await tap(turnStarted('render-write-failure-node', 'turn'));
        await tap(graphDelta('render-write-failure-node', 'llm.text.delta', 'answer'));

        // Then
        const primaryMessage = 'Interactive graph render failed: preview failed \\u{001B}[31m\n';
        const fallbackAttempt = 'Error: preview failed \\u{001B}[31m\n';
        const nestedMessage =
            'Interactive graph render error write failed: write failed [REDACTED_CREDENTIAL]\\u{0007}\\u{000A}\\u{2066}\n';
        expect(stderrWrite.mock.calls).toEqual([[primaryMessage], [nestedMessage]]);
        expect(writeAttempts).toEqual([fallbackAttempt]);
        expectSafeFraming(primaryMessage);
        expectSafeFraming(fallbackAttempt);
        expectSafeFraming(nestedMessage);
        expect(`${primaryMessage}${fallbackAttempt}${nestedMessage}`).not.toContain(secret);
    });

    it('leaves ordinary printable Unicode in normal graph transcript fallback bytes unchanged', async () => {
        // Given
        const recording = createPlainRecording();
        const message = 'ordinary café 한글 😀';

        // When
        await interactiveGraphStreamSignal(
            recording.output,
            renderState(),
            '/workspace',
        )(graphFailure('ordinary-node', message));

        // Then
        expect(recording.writes).toEqual([`✗ ordinary-node: ${message}\n`]);
    });
});
