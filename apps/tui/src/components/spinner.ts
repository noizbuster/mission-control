import { type Accessor, createSignal, onCleanup, onMount } from 'solid-js';

/**
 * Shared braille spinner primitives. Default mode is `'static'` (no interval)
 * because animated frames force terminal redraws. Opt in with `MCTRL_SPINNER=animate`.
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

export function useSpinnerFrame(): { readonly glyph: Accessor<string>; readonly animated: boolean } {
    const mode = resolveSpinnerMode();
    const [frame, setFrame] = createSignal(0);
    onMount(() => {
        if (mode === 'static') {
            return;
        }
        const timer = setInterval(() => {
            setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
        }, SPINNER_INTERVAL_MS);
        onCleanup(() => {
            clearInterval(timer);
        });
    });
    const glyph = (): string =>
        mode === 'static' ? SPINNER_STATIC_GLYPH : (SPINNER_FRAMES[frame()] ?? SPINNER_STATIC_GLYPH);
    return { glyph, animated: mode === 'animate' };
}
