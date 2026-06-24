import { describe, expect, it } from 'vitest';
import { buildSeparatorLine, createInkChatBridgeCore, resolveSeparatorState } from './ink-chat-bridge.js';

const LIGHT = '\u2500'; // ─
const HEAVY = '\u2501'; // ━

describe('resolveSeparatorState', () => {
    it('is running while generating', () => {
        const snapshot = { ...createInkChatBridgeCore().snapshot, generating: true };
        expect(resolveSeparatorState(snapshot)).toBe('running');
    });

    it('is awaiting_input while an approval is pending', () => {
        const snapshot = { ...createInkChatBridgeCore().snapshot, approvalActive: true };
        expect(resolveSeparatorState(snapshot)).toBe('awaiting_input');
    });

    it('is awaiting_input while a question is pending', () => {
        const snapshot = { ...createInkChatBridgeCore().snapshot, questionActive: true };
        expect(resolveSeparatorState(snapshot)).toBe('awaiting_input');
    });

    it('is idle when not generating and no overlay is pending', () => {
        expect(resolveSeparatorState(createInkChatBridgeCore().snapshot)).toBe('idle');
    });

    it('prefers running over awaiting_input when both are active', () => {
        const snapshot = {
            ...createInkChatBridgeCore().snapshot,
            generating: true,
            approvalActive: true,
        };
        expect(resolveSeparatorState(snapshot)).toBe('running');
    });
});

describe('buildSeparatorLine', () => {
    const width = 30;

    it('idle is a dim light line with no color', () => {
        const { text, color, dimColor } = buildSeparatorLine('idle', false, 0, width);
        expect(text).toBe(LIGHT.repeat(width));
        expect(color).toBeUndefined();
        expect(dimColor).toBe(true);
    });

    it('running (static) is a heavy yellow line', () => {
        const { text, color, dimColor } = buildSeparatorLine('running', false, 0, width);
        expect(text).toBe(HEAVY.repeat(width));
        expect(color).toBe('yellow');
        expect(dimColor).toBe(false);
    });

    it('running (animated) sweeps a heavy comet across a light line and advances with frames', () => {
        const atFrame0 = buildSeparatorLine('running', true, 0, width);
        const atFrame5 = buildSeparatorLine('running', true, 5, width);
        expect(atFrame0.text).toHaveLength(width);
        expect(atFrame0.color).toBe('yellow');
        // Frame 0 starts with the comet off the left edge, so the line opens light.
        expect(atFrame0.text.startsWith(LIGHT)).toBe(true);
        // Contains both weights once the comet is on-screen.
        expect(atFrame5.text.includes(HEAVY)).toBe(true);
        expect(atFrame5.text.includes(LIGHT)).toBe(true);
        // The comet moves, so different frames render different lines.
        expect(atFrame0.text).not.toBe(atFrame5.text);
    });

    it('awaiting_input (static) is a heavy magenta line', () => {
        const { text, color, dimColor } = buildSeparatorLine('awaiting_input', false, 0, width);
        expect(text).toBe(HEAVY.repeat(width));
        expect(color).toBe('magenta');
        expect(dimColor).toBe(false);
    });

    it('awaiting_input (animated) pulses between heavy-bright and light-dim', () => {
        // Pulse period is SEPARATOR_PULSE_HALF*2 = 4 frames; bright when frame%4 < 2.
        const bright = buildSeparatorLine('awaiting_input', true, 0, width);
        const dim = buildSeparatorLine('awaiting_input', true, 2, width);
        expect(bright.text).toBe(HEAVY.repeat(width));
        expect(bright.dimColor).toBe(false);
        expect(dim.text).toBe(LIGHT.repeat(width));
        expect(dim.dimColor).toBe(true);
        expect(bright.color).toBe('magenta');
        expect(dim.color).toBe('magenta');
    });

    it('always emits exactly `width` characters regardless of state or frame', () => {
        const states = ['idle', 'running', 'awaiting_input'] as const;
        for (const state of states) {
            for (let frame = 0; frame < 12; frame += 1) {
                const line = buildSeparatorLine(state, true, frame, width);
                expect(line.text).toHaveLength(width);
                // string-width counts box-drawing chars as 1, so never overflows.
                expect([...line.text].length).toBe(width);
            }
        }
    });
});
