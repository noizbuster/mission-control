/** @jsxImportSource @opentui/solid */

import { testRender } from '@opentui/solid';
import { For } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { TranscriptPart } from '../state/transcript-part';
import { TranscriptPartRenderer } from './TranscriptPartRenderer';

const OSC8 = '\u001B]8;;https://attacker.invalid\u0007';
const CSI = '\u001B[2J';
const C1_CSI = '\u009B2J';
const BIDI = '\u202E';
const CREDENTIAL = 'sk-displayblocker123';
const UNSAFE_TEXT = `安全 家族\u200D絵 ${CREDENTIAL}${OSC8}${CSI}${C1_CSI}${BIDI}`;

function hasUnsafeTerminalControl(frame: string): boolean {
    return Array.from(frame).some((character) => {
        const codePoint = character.codePointAt(0) ?? -1;
        return (
            (codePoint <= 0x1f && codePoint !== 0x0a) ||
            (codePoint >= 0x7f && codePoint <= 0x9f) ||
            codePoint === 0x061c ||
            codePoint === 0x200e ||
            codePoint === 0x200f ||
            (codePoint >= 0x202a && codePoint <= 0x202e) ||
            (codePoint >= 0x2066 && codePoint <= 0x2069)
        );
    });
}

const unsafeTranscriptParts = [
    { id: 'user', type: 'user', text: UNSAFE_TEXT },
    { id: 'assistant', type: 'assistant', text: UNSAFE_TEXT },
    { id: 'reasoning', type: 'reasoning', text: UNSAFE_TEXT },
    { id: 'inline-tool', type: 'inline-tool', text: UNSAFE_TEXT, title: UNSAFE_TEXT },
    { id: 'block-tool', type: 'block-tool', text: UNSAFE_TEXT, title: UNSAFE_TEXT },
    { id: 'diff', type: 'diff', text: UNSAFE_TEXT, filePath: UNSAFE_TEXT },
    { id: 'code', type: 'code', text: UNSAFE_TEXT, filePath: UNSAFE_TEXT, language: 'ts' },
    { id: 'command', type: 'command', text: UNSAFE_TEXT, command: UNSAFE_TEXT },
    { id: 'subagent', type: 'subagent', text: UNSAFE_TEXT, agentName: UNSAFE_TEXT, sessionId: UNSAFE_TEXT },
    { id: 'status', type: 'status', text: UNSAFE_TEXT, title: UNSAFE_TEXT },
    { id: 'event', type: 'event', text: UNSAFE_TEXT, eventType: UNSAFE_TEXT, timestamp: UNSAFE_TEXT },
    { id: 'error', type: 'error', text: UNSAFE_TEXT, code: UNSAFE_TEXT },
    { id: 'legacy', type: 'legacy', text: `Assistant: ${UNSAFE_TEXT}` },
] satisfies readonly TranscriptPart[];

describe('TranscriptPartRenderer terminal sanitization', () => {
    it('renders every typed transcript variant as safe terminal text without changing its canonical source part', async () => {
        // Given: hostile values across every typed transcript variant.
        const originalParts = structuredClone(unsafeTranscriptParts);
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <For each={unsafeTranscriptParts}>
                        {(part, index) => (
                            <TranscriptPartRenderer
                                part={part}
                                showThinking={true}
                                toolOutputExpanded={true}
                                viewportColumns={160}
                                isFirst={index() === 0}
                                isLast={index() === unsafeTranscriptParts.length - 1}
                            />
                        )}
                    </For>
                </box>
            ),
            { width: 160, height: 64 },
        );

        try {
            // When: the mounted renderer projects the canonical transcript values into a terminal frame.
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            // Then: the frame is redacted and control-safe while the source union remains byte-exact.
            expect(frame).toContain('安全');
            expect(frame).toContain('家族\u200D絵');
            expect(frame).toContain('[REDACTED_CREDENTIAL]');
            expect(frame).not.toContain(CREDENTIAL);
            expect(frame).not.toContain(OSC8);
            expect(frame).not.toContain(CSI);
            expect(frame).not.toContain(C1_CSI);
            expect(frame).not.toContain(BIDI);
            expect(frame).toContain('\\u{001B}');
            expect(frame).toContain('\\u{0007}');
            expect(frame).toContain('\\u{009B}');
            expect(frame).toContain('\\u{202E}');
            expect(hasUnsafeTerminalControl(frame), frame).toBe(false);
            expect(unsafeTranscriptParts).toEqual(originalParts);
            expect(unsafeTranscriptParts.every((part) => part.text.includes(CREDENTIAL))).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});
