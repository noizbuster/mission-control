import { describe, expect, it } from 'vitest';
import { printableCharFromKey } from './overlay-key-input.js';

const key = (
    name: string,
    mods: Partial<{ ctrl: boolean; meta: boolean }> = {},
): Parameters<typeof printableCharFromKey>[0] => ({
    name,
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
});

describe('printableCharFromKey', () => {
    it('returns the single-char name for a printable letter', () => {
        expect(printableCharFromKey(key('a'))).toBe('a');
        expect(printableCharFromKey(key('Z'))).toBe('Z');
        expect(printableCharFromKey(key('5'))).toBe('5');
    });

    it('maps the space key name to a literal space', () => {
        expect(printableCharFromKey(key('space'))).toBe(' ');
    });

    it('returns undefined for multi-char control-key names', () => {
        expect(printableCharFromKey(key('return'))).toBe(undefined);
        expect(printableCharFromKey(key('escape'))).toBe(undefined);
        expect(printableCharFromKey(key('backspace'))).toBe(undefined);
        expect(printableCharFromKey(key('tab'))).toBe(undefined);
        expect(printableCharFromKey(key('up'))).toBe(undefined);
    });

    it('returns undefined when ctrl or meta is held', () => {
        expect(printableCharFromKey(key('a', { ctrl: true }))).toBe(undefined);
        expect(printableCharFromKey(key('space', { meta: true }))).toBe(undefined);
    });
});
