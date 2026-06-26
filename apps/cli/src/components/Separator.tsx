/** @jsxImportSource @opentui/react */
import { useEffect, useState } from 'react';
import { resolveSpinnerMode } from './spinner.js';

export type SeparatorProps = {
    readonly state: SeparatorState;
    readonly width?: number;
};

export type SeparatorState = 'running' | 'awaiting_input' | 'idle';

const SEPARATOR_INTERVAL_MS = 80;
const SEPARATOR_LIGHT = '\u2500'; // ─ light horizontal
const SEPARATOR_HEAVY = '\u2501'; // ━ heavy horizontal
const SEPARATOR_COMET_LENGTH = 8;
const SEPARATOR_COMET_STEP = 2;
// Awaiting-input pulse: N frames bright, N frames dim, repeating (~3 Hz at 80 ms).
const SEPARATOR_PULSE_HALF = 2;

/**
 * Build the separator line for a given chat state. Moved here (canonical home)
 * from the chat bridge so the bridge imports it rather than owning a duplicate.
 *
 *   running         — yellow; a bright "comet" sweeps left→right while the agent works
 *   awaiting_input  — magenta; a slow pulse while an approval/question decision is pending
 *   idle            — dim, static (calm; no re-renders, respects terminal selection)
 *
 * Animation is gated by `MCTRL_SPINNER=animate`, the same knob as the braille
 * spinner, because every animated frame drives a renderer redraw that disrupts
 * terminal mouse text selection. In static mode the three states stay
 * distinguishable via color and line weight (heavy vs light).
 */
export function buildSeparatorLine(
    state: SeparatorState,
    animated: boolean,
    frame: number,
    width: number,
): { readonly text: string; readonly color: string | undefined; readonly dimColor: boolean } {
    if (state === 'idle') {
        return { text: SEPARATOR_LIGHT.repeat(width), color: undefined, dimColor: true };
    }
    if (state === 'running') {
        if (!animated) {
            return { text: SEPARATOR_HEAVY.repeat(width), color: 'yellow', dimColor: false };
        }
        const span = width + SEPARATOR_COMET_LENGTH;
        const head = ((frame * SEPARATOR_COMET_STEP) % span) - SEPARATOR_COMET_LENGTH;
        let line = '';
        for (let i = 0; i < width; i += 1) {
            line += i >= head && i < head + SEPARATOR_COMET_LENGTH ? SEPARATOR_HEAVY : SEPARATOR_LIGHT;
        }
        return { text: line, color: 'yellow', dimColor: false };
    }
    if (!animated) {
        return { text: SEPARATOR_HEAVY.repeat(width), color: 'magenta', dimColor: false };
    }
    const bright = frame % (SEPARATOR_PULSE_HALF * 2) < SEPARATOR_PULSE_HALF;
    return {
        text: (bright ? SEPARATOR_HEAVY : SEPARATOR_LIGHT).repeat(width),
        color: 'magenta',
        dimColor: !bright,
    };
}

/**
 * opentui-native separator. Owns its own frame timer (`SEPARATOR_INTERVAL_MS`);
 * `width` is optional for testability (defaults to terminal width minus one to
 * avoid autowrap phantom lines).
 */
export function Separator({ state, width }: SeparatorProps): React.ReactNode {
    const animated = resolveSpinnerMode() === 'animate';
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (!animated || state === 'idle') {
            return;
        }
        const timer = setInterval(() => {
            setFrame((current) => current + 1);
        }, SEPARATOR_INTERVAL_MS);
        return () => {
            clearInterval(timer);
        };
    }, [animated, state]);
    const columns = width ?? Math.max(1, (process.stdout.columns ?? 80) - 1);
    const { text, color, dimColor } = buildSeparatorLine(state, animated, frame, columns);
    const resolvedFg = color === 'yellow' ? '#ffff00' : color === 'magenta' ? '#ff00ff' : undefined;
    return (
        <text {...(resolvedFg !== undefined ? { fg: resolvedFg } : {})} {...(dimColor ? { dim: true } : {})}>
            {text}
        </text>
    );
}
