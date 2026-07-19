/** @jsxImportSource @opentui/solid */
import { testRender } from '@opentui/solid';
import { type JSX, onMount } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { ClipboardServiceRenderer } from '../platform/clipboard-service';
import { MissionControlClipboardToastProviders, useTuiToast } from '../platform/providers/clipboard-toast-context';
import { Toast } from './Toast';

const OSC8 = '\u001B]8;;https://attacker.invalid\u0007';
const CSI = '\u001B[2J';
const C1_CSI = '\u009B2J';
const BIDI = '\u202E';
const BEL = '\u0007';
const CREDENTIAL = 'sk-displayblocker123';

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

const testClipboardRenderer: ClipboardServiceRenderer = {
    copyToClipboardOSC52(): boolean {
        return false;
    },
    isOsc52Supported(): boolean {
        return false;
    },
};

function expectTerminalControlsToBeEscaped(frame: string): void {
    expect(hasUnsafeTerminalControl(frame), frame).toBe(false);
    expect(frame).not.toContain(OSC8);
    expect(frame).not.toContain(CSI);
    expect(frame).not.toContain(C1_CSI);
    expect(frame).not.toContain(BIDI);
    expect(frame).not.toContain(BEL);
    expect(frame).toContain('\\u{001B}');
    expect(frame).toContain('\\u{0007}');
    expect(frame).toContain('\\u{009B}');
    expect(frame).toContain('\\u{202E}');
}

function expectCredentialToBeRedacted(frame: string): void {
    expect(frame).toContain('[REDACTED_CREDENTIAL]');
    expect(frame).not.toContain(CREDENTIAL);
}

function UnsafeToastScenario(): JSX.Element {
    const toast = useTuiToast();
    onMount(() => {
        toast.show({
            title: `通知${BEL} ${CREDENTIAL}${OSC8}`,
            message: `詳細 ${CREDENTIAL} 一行目\n二行目 家族\u200D絵${CSI}${C1_CSI}${BIDI}`,
            variant: 'warning',
            duration: 60_000,
        });
    });
    return <Toast />;
}

describe('Toast terminal sanitization', () => {
    it('escapes controls in mounted title and message while preserving CJK, LF, and ZWJ content', async () => {
        const setup = await testRender(
            () => (
                <MissionControlClipboardToastProviders useRenderer={() => testClipboardRenderer}>
                    <UnsafeToastScenario />
                </MissionControlClipboardToastProviders>
            ),
            { width: 96, height: 18 },
        );

        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();

            expect(frame).toContain('通知');
            expect(frame).toContain('詳細');
            expect(frame).toMatch(/一行目[^\n]*\n[^\n]*二行目/u);
            expect(frame).toContain('家族\u200D絵');
            expectCredentialToBeRedacted(frame);
            expectTerminalControlsToBeEscaped(frame);
        } finally {
            setup.renderer.destroy();
        }
    });
});
