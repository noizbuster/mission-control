/** @jsxImportSource @opentui/solid */

import type { ChatBlock } from '@mission-control/tui/chat';
import { testRender } from '@opentui/solid';
import { For } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { LegacyMessageBlock } from './LegacyTranscriptRenderer';

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

const unsafeBlocks = [
    { kind: 'system', lines: [`System: ${UNSAFE_TEXT}`] },
    { kind: 'tool', lines: [`Tool: ${UNSAFE_TEXT}`] },
    { kind: 'thinking', lines: [`Thinking: ${UNSAFE_TEXT}`] },
    { kind: 'assistant', lines: [`Assistant: ${UNSAFE_TEXT}`] },
    { kind: 'error', lines: [`Error: ${UNSAFE_TEXT}`] },
    { kind: 'user', lines: [`You: ${UNSAFE_TEXT}`] },
] satisfies readonly ChatBlock[];

describe('LegacyMessageBlock terminal sanitization', () => {
    it('renders every legacy block kind as safe terminal text without changing canonical block lines', async () => {
        // Given: hostile raw lines classified into every legacy transcript block kind.
        const originalBlocks = structuredClone(unsafeBlocks);
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <For each={unsafeBlocks}>
                        {(block, index) => (
                            <LegacyMessageBlock
                                block={block}
                                isStreaming={false}
                                toolOutputExpanded={true}
                                viewportColumns={160}
                                isFirst={index() === 0}
                            />
                        )}
                    </For>
                </box>
            ),
            { width: 160, height: 48 },
        );

        try {
            // When: the blocks are rendered through the legacy transcript sink.
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            // Then: only the frame is redacted and escaped; classified raw blocks are unchanged.
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
            expect(unsafeBlocks).toEqual(originalBlocks);
            expect(unsafeBlocks.every((block) => block.lines[0]?.includes(CREDENTIAL) === true)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});
