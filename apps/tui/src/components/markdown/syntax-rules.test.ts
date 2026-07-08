import { describe, expect, it } from 'vitest';
import { buildSyntaxRules, darkSyntaxPalette } from './syntax-rules.js';

// Note: we deliberately do NOT call `SyntaxStyle.fromTheme(rules)` here. That
// call wraps a native Zig pointer requiring the FFI backend (node:ffi +
// libopentui), which is only available under `--experimental-ffi` with the
// platform native library loaded. Constructing it in a unit test would force
// worker/native initialization at import time. Live construction plus
// `.destroy()` is validated in the orchestrator integration tests; this unit
// test asserts the rule-table data shape only.

describe('darkSyntaxPalette', () => {
    it('pins the keyword bucket to #c792ea and exposes all ten buckets', () => {
        expect(darkSyntaxPalette.keyword).toBe('#c792ea');
        expect(darkSyntaxPalette.comment).toBe('#637777');
        expect(darkSyntaxPalette.function).toBe('#82aaff');
        expect(darkSyntaxPalette.variable).toBe('#eeffff');
        expect(darkSyntaxPalette.string).toBe('#c3e88d');
        expect(darkSyntaxPalette.number).toBe('#f78c6c');
        expect(darkSyntaxPalette.type).toBe('#ffcb6b');
        expect(darkSyntaxPalette.operator).toBe('#89ddff');
        expect(darkSyntaxPalette.punctuation).toBe('#89ddff');
        expect(darkSyntaxPalette.default).toBe('#eeffff');
    });
});

describe('buildSyntaxRules', () => {
    const rules = buildSyntaxRules();

    it('returns a non-empty readonly rule table', () => {
        expect(rules.length).toBeGreaterThan(0);
    });

    it('maps the `keyword` scope to the #c792ea foreground', () => {
        const keywordRule = rules.find((rule) => rule.scope.includes('keyword'));
        expect(keywordRule).toBeDefined();
        expect(keywordRule?.style.foreground).toBe('#c792ea');
    });

    const buckets = [
        'comment',
        'keyword',
        'function',
        'variable',
        'string',
        'number',
        'type',
        'operator',
        'punctuation',
    ] as const;

    it.each(buckets)('covers the %s palette bucket with at least one rule', (bucket) => {
        const hex = darkSyntaxPalette[bucket];
        const covers = rules.some((rule) => rule.style.foreground === hex);
        expect(covers, `no rule foreground equals palette.${bucket} (${hex})`).toBe(true);
    });

    it('gives every rule a non-empty array of non-empty scope strings', () => {
        for (const rule of rules) {
            expect(Array.isArray(rule.scope)).toBe(true);
            expect(rule.scope.length, `scope was ${JSON.stringify(rule.scope)}`).toBeGreaterThan(0);
            for (const scope of rule.scope) {
                expect(typeof scope).toBe('string');
                expect(scope.length).toBeGreaterThan(0);
            }
        }
    });

    it('only carries foreground plus the style flags each entry uses', () => {
        // Guards against accidental `bold: undefined` / `foreground: undefined`
        // which exactOptionalPropertyTypes forbids and would muddle rendering.
        for (const rule of rules) {
            for (const value of Object.values(rule.style)) {
                expect(value, `style had an undefined entry in ${JSON.stringify(rule.scope)}`).toBeDefined();
            }
            expect(rule.style.foreground).toBeTruthy();
        }
    });
});
