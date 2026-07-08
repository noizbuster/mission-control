import { useEffect, useState } from 'react';

/**
 * Shared braille spinner primitives. Default mode is `'static'` (no interval, no re-renders)
 * because the terminal renderer's per-frame re-render writes ANSI redraw escapes to stdout and
 * disrupts terminal mouse text selection. `'animate'` restores the 80ms braille animation. Set
 * via `MCTRL_SPINNER`.
 */
export const SPINNER_FRAMES = [
    '\u280B',
    '\u2819',
    '\u2839',
    '\u2838',
    '\u283C',
    '\u2834',
    '\u2826',
    '\u2827',
    '\u2807',
    '\u280F',
] as const;

export const SPINNER_INTERVAL_MS = 80;
export const SPINNER_STATIC_GLYPH = '\u25CF';
export const SPINNER_MODE_ENV = 'MCTRL_SPINNER';

export function resolveSpinnerMode(env: NodeJS.ProcessEnv = process.env): 'static' | 'animate' {
    return env[SPINNER_MODE_ENV] === 'animate' ? 'animate' : 'static';
}

/**
 * Drive an animated spinner frame. Returns the current glyph and whether animation is active.
 * In `'static'` mode (the default) the glyph is fixed and no interval is scheduled, so callers
 * that embed the glyph in a dense layout (e.g. per-node graph rows) do not trigger per-frame
 * renderer redraws unless the operator opts in via `MCTRL_SPINNER=animate`.
 */
export function useSpinnerFrame(): { readonly glyph: string; readonly animated: boolean } {
    const mode = resolveSpinnerMode();
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (mode === 'static') {
            return;
        }
        const timer = setInterval(() => {
            setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
        }, SPINNER_INTERVAL_MS);
        return () => {
            clearInterval(timer);
        };
    }, [mode]);
    const glyph = mode === 'static' ? SPINNER_STATIC_GLYPH : (SPINNER_FRAMES[frame] ?? SPINNER_STATIC_GLYPH);
    return { glyph, animated: mode === 'animate' };
}
