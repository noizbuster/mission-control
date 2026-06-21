import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSpinnerMode } from './ink-chat-bridge.js';

const ENV_KEY = 'MCTRL_SPINNER';

describe('resolveSpinnerMode (MCTRL_SPINNER env var)', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalEnv = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
    });

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env[ENV_KEY];
        } else {
            process.env[ENV_KEY] = originalEnv;
        }
    });

    it('defaults to "static" when MCTRL_SPINNER is unset (no interval = mouse selection works)', () => {
        expect(resolveSpinnerMode()).toBe('static');
    });

    it('returns "static" when MCTRL_SPINNER=static', () => {
        process.env[ENV_KEY] = 'static';
        expect(resolveSpinnerMode()).toBe('static');
    });

    it('returns "animate" when MCTRL_SPINNER=animate (opt-in to original 80ms braille)', () => {
        process.env[ENV_KEY] = 'animate';
        expect(resolveSpinnerMode()).toBe('animate');
    });

    it('falls back to "static" for unknown values (typo-safe default)', () => {
        process.env[ENV_KEY] = 'animated';
        expect(resolveSpinnerMode()).toBe('static');

        process.env[ENV_KEY] = 'true';
        expect(resolveSpinnerMode()).toBe('static');

        process.env[ENV_KEY] = '1';
        expect(resolveSpinnerMode()).toBe('static');
    });

    it('accepts an explicit env record for hermetic tests', () => {
        expect(resolveSpinnerMode({ [ENV_KEY]: 'animate' })).toBe('animate');
        expect(resolveSpinnerMode({})).toBe('static');
    });
});
