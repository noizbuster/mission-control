import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSpinnerMode } from './spinner';

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

    it('defaults to "animate" when MCTRL_SPINNER is unset', () => {
        expect(resolveSpinnerMode()).toBe('animate');
    });

    it('returns "static" when MCTRL_SPINNER=static', () => {
        process.env[ENV_KEY] = 'static';
        expect(resolveSpinnerMode()).toBe('static');
    });

    it('returns "animate" when MCTRL_SPINNER=animate', () => {
        process.env[ENV_KEY] = 'animate';
        expect(resolveSpinnerMode()).toBe('animate');
    });

    it('falls back to "animate" for unknown values', () => {
        process.env[ENV_KEY] = 'animated';
        expect(resolveSpinnerMode()).toBe('animate');

        process.env[ENV_KEY] = 'true';
        expect(resolveSpinnerMode()).toBe('animate');
    });

    it('accepts an explicit env record for hermetic tests', () => {
        expect(resolveSpinnerMode({ [ENV_KEY]: 'static' })).toBe('static');
        expect(resolveSpinnerMode({})).toBe('animate');
    });
});
