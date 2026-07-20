import { describe, expect, it } from 'vitest';
import { buildSyntaxRules, darkSyntaxPalette } from './syntax-rules';

// Note: we deliberately do NOT call `SyntaxStyle.fromTheme(rules)` here. That
// call wraps a native Zig pointer requiring the FFI backend (node:ffi +
// libopentui), which is only available under `--experimental-ffi` with the
// platform native library loaded. Constructing it in a unit test would force
// worker/native initialization at import time. Live construction plus
// `.destroy()` is validated in the orchestrator integration tests; this unit
// test asserts the rule-table data shape only.

describe('darkSyntaxPalette', () => {
    it('pins OpenCode opencode.json dark buckets', () => {
        expect(darkSyntaxPalette.keyword).toBe('#9d7cd8');
        expect(darkSyntaxPalette.comment).toBe('#808080');
        expect(darkSyntaxPalette.function).toBe('#fab283');
        expect(darkSyntaxPalette.variable).toBe('#e06c75');
        expect(darkSyntaxPalette.string).toBe('#7fd88f');
        expect(darkSyntaxPalette.number).toBe('#f5a742');
        expect(darkSyntaxPalette.type).toBe('#e5c07b');
        expect(darkSyntaxPalette.operator).toBe('#56b6c2');
        expect(darkSyntaxPalette.punctuation).toBe('#eeeeee');
        expect(darkSyntaxPalette.default).toBe('#eeeeee');
    });
});

describe('buildSyntaxRules', () => {
    const rules = buildSyntaxRules();

    it('returns a non-empty readonly rule table', () => {
        expect(rules.length).toBeGreaterThan(0);
    });

    it('maps the `keyword` scope to the OpenCode accent foreground', () => {
        const keywordRule = rules.find((rule) => rule.scope.includes('keyword'));
        expect(keywordRule).toBeDefined();
        expect(keywordRule?.style.foreground).toBe('#9d7cd8');
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

    it('registers every markup scope OpenTUI MarkdownRenderable looks up', () => {
        const scopes = new Set(rules.flatMap((rule) => rule.scope));
        for (const required of [
            'markup.heading',
            'markup.strong',
            'markup.italic',
            'markup.strikethrough',
            'markup.list',
            'markup.quote',
            'markup.raw',
            'markup.link',
            'markup.link.label',
            'markup.link.url',
            'conceal',
            'default',
        ]) {
            expect(scopes.has(required), `missing scope ${required}`).toBe(true);
        }
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
        for (const rule of rules) {
            for (const value of Object.values(rule.style)) {
                expect(value, `style had an undefined entry in ${JSON.stringify(rule.scope)}`).toBeDefined();
            }
            expect(rule.style.foreground).toBeTruthy();
        }
    });
});
