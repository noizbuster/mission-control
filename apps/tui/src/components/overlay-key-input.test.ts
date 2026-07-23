import { describe, expect, it } from 'vitest';
import { printableCharFromKey } from './overlay-key-input';

const key = (
    name: string,
    options: Partial<{ ctrl: boolean; meta: boolean; super: boolean; sequence: string }> = {},
): Parameters<typeof printableCharFromKey>[0] => ({
    name,
    ctrl: options.ctrl ?? false,
    meta: options.meta ?? false,
    ...(options.super === undefined ? {} : { super: options.super }),
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
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

    it('prefers a single-character sequence over a non-printable key identity', () => {
        // Given: keypad keys with canonical multi-character names
        const minus = key('kpminus', { sequence: '-' });
        const divide = key('kpdivide', { sequence: '/' });

        // When: their printable sequences are read
        const characters = [printableCharFromKey(minus), printableCharFromKey(divide)];

        // Then: the literal input sequences are retained
        expect(characters).toEqual(['-', '/']);
    });

    it('returns undefined for multi-char control-key names', () => {
        expect(printableCharFromKey(key('return'))).toBe(undefined);
        expect(printableCharFromKey(key('escape'))).toBe(undefined);
        expect(printableCharFromKey(key('backspace'))).toBe(undefined);
        expect(printableCharFromKey(key('tab'))).toBe(undefined);
        expect(printableCharFromKey(key('up'))).toBe(undefined);
    });

    it('returns undefined when a command modifier is held', () => {
        expect(printableCharFromKey(key('a', { ctrl: true }))).toBe(undefined);
        expect(printableCharFromKey(key('space', { meta: true }))).toBe(undefined);
        expect(printableCharFromKey(key('a', { super: true }))).toBe(undefined);
    });
});
