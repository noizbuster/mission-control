import { describe, expect, it } from 'vitest';
import { isRecord, isRecordOrArray } from './is-record';

describe('isRecord (strict)', () => {
    it('accepts plain objects', () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ key: 'value' })).toBe(true);
    });

    it('rejects arrays, null, and primitives', () => {
        expect(isRecord([])).toBe(false);
        expect(isRecord(['a'])).toBe(false);
        expect(isRecord(null)).toBe(false);
        expect(isRecord(undefined)).toBe(false);
        expect(isRecord('string')).toBe(false);
        expect(isRecord(42)).toBe(false);
        expect(isRecord(true)).toBe(false);
    });
});

describe('isRecordOrArray (array-inclusive)', () => {
    it('accepts plain objects and arrays, rejects null and primitives', () => {
        expect(isRecordOrArray({})).toBe(true);
        expect(isRecordOrArray([])).toBe(true);
        expect(isRecordOrArray(null)).toBe(false);
        expect(isRecordOrArray(undefined)).toBe(false);
        expect(isRecordOrArray('string')).toBe(false);
        expect(isRecordOrArray(42)).toBe(false);
    });
});
