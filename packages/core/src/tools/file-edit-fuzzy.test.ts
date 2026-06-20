import { describe, expect, it } from 'vitest';
import type { FuzzyReplaceResult } from './file-edit-fuzzy.js';
import {
    BlockAnchorReplacer,
    ContextAwareReplacer,
    EscapeNormalizedReplacer,
    IndentationFlexibleReplacer,
    isDisproportionateMatch,
    LineTrimmedReplacer,
    levenshtein,
    MultiOccurrenceReplacer,
    renderUnifiedDiff,
    replace,
    SimpleReplacer,
    TrimmedBoundaryReplacer,
    WhitespaceNormalizedReplacer,
} from './file-edit-fuzzy.js';

describe('levenshtein', () => {
    it('returns 0 for identical strings', () => {
        expect(levenshtein('hello', 'hello')).toBe(0);
    });

    it('returns length difference for empty vs non-empty', () => {
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('abc', '')).toBe(3);
        expect(levenshtein('', '')).toBe(0);
    });

    it('computes single substitution as 1', () => {
        expect(levenshtein('cat', 'bat')).toBe(1);
    });

    it('computes distance for completely different strings', () => {
        expect(levenshtein('abc', 'xyz')).toBe(3);
    });

    it('computes insertion distance', () => {
        expect(levenshtein('kitten', 'sitting')).toBe(3);
    });
});

describe('isDisproportionateMatch', () => {
    it('returns false for identical line counts', () => {
        expect(isDisproportionateMatch('line1\nline2', 'line1\nline2')).toBe(false);
    });

    it('returns true when matched span has far more lines', () => {
        const old = 'a\nb';
        const search = 'a\nx\ny\nz\nw';
        expect(isDisproportionateMatch(search, old)).toBe(true);
    });

    it('exempts single-line oldString from the character-length guard', () => {
        const huge = 'x'.repeat(1000);
        expect(isDisproportionateMatch(huge, 'q')).toBe(false);
    });

    it('returns true when char length exceeds 4x threshold for multi-line oldString', () => {
        const padding = ' '.repeat(600);
        const search = `a${padding}b\nc${padding}d`;
        expect(isDisproportionateMatch(search, 'a b\nc d')).toBe(true);
    });

    it('allows reasonable line-count difference within 2x bound', () => {
        expect(isDisproportionateMatch('a\nb\nc\nd\ne', 'a\nb\nc\nd')).toBe(false);
    });
});

describe('replace — integration through the replacer chain', () => {
    it('1. matches exact text (SimpleReplacer baseline)', () => {
        const result = replace('foo bar baz', 'bar', 'qux');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('foo qux baz');
        expect(result.matchedText).toBe('bar');
    });

    it('2. matches despite extra whitespace between words', () => {
        const result = replace('hello    world', 'hello world', 'hi world');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('hi world');
        expect(result.matchedText).toBe('hello    world');
    });

    it('3. matches despite indentation differences', () => {
        const content = 'def hello():\n    return 1\n    pass';
        const result = replace(content, 'return 1\npass', '    return 2\n    pass');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('def hello():\n    return 2\n    pass');
        expect(result.matchedText).toBe('    return 1\n    pass');
    });

    it('4. matches literal backslash-n escapes against actual newlines', () => {
        const result = replace('hello\nworld', 'hello\\nworld', 'hi there');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('hi there');
        expect(result.matchedText).toBe('hello\nworld');
    });

    it('5. matches multi-line blocks via first/last line anchors', () => {
        const content = 'header\n  alpha\n  beta\nfooter\nrest';
        const result = replace(content, 'header\n  alpha\nfooter', 'REPLACED');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('REPLACED\nrest');
        expect(result.matchedText).toBe('header\n  alpha\n  beta\nfooter');
    });

    it('6. matches when oldString has stray surrounding whitespace', () => {
        const result = replace('prefix hello world suffix', '   hello world   ', 'GOODBYE');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('prefix GOODBYE suffix');
        expect(result.matchedText).toBe('hello world');
    });

    it('7. rejects a disproportionate fuzzy match', () => {
        const padding = ' '.repeat(260);
        const content = `a${padding}b\nc${padding}d`;
        const result = replace(content, 'a b\nc d', 'X');
        expect(result.status).toBe('disproportionate');
        if (result.status !== 'disproportionate') return;
        expect(result.matchedText).toBe(content);
    });

    it('8. replaces all occurrences when replaceAll is true', () => {
        const result = replace('foo bar foo baz foo', 'foo', 'X', true);
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('X bar X baz X');
    });

    it('9. returns not_unique when multiple matches exist without replaceAll', () => {
        const result = replace('foo bar foo', 'foo', 'X');
        expect(result.status).toBe('not_unique');
    });

    it('10. returns not_found when nothing matches', () => {
        const result = replace('hello world', 'xyz', 'abc');
        expect(result.status).toBe('not_found');
    });
});

describe('replace — edge cases', () => {
    it('returns identical_input when oldString equals newString', () => {
        const result: FuzzyReplaceResult = replace('hello', 'hello', 'hello');
        expect(result.status).toBe('identical_input');
    });

    it('returns empty_old when oldString is empty', () => {
        const result: FuzzyReplaceResult = replace('hello', '', 'world');
        expect(result.status).toBe('empty_old');
    });

    it('matches escape differences across multiple lines', () => {
        const content = 'line1\tvalue1\nline2\tvalue2';
        const result = replace(content, 'line1\\tvalue1\\nline2\\tvalue2', 'replaced');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('replaced');
    });

    it('respects replaceAll=false default (single unique match applies)', () => {
        const result = replace('only once here', 'once', 'twice');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.result).toBe('only twice here');
    });

    it('handles tab vs space indentation mismatch', () => {
        const content = 'function f() {\n\treturn 1;\n}';
        const result = replace(content, 'function f() {\n    return 1;\n}', 'function f() {\n    return 2;\n}');
        expect(result.status).toBe('applied');
        if (result.status !== 'applied') return;
        expect(result.matchedText).toBe('function f() {\n\treturn 1;\n}');
        expect(result.result).toBe('function f() {\n    return 2;\n}');
    });
});

describe('individual replacers', () => {
    it('SimpleReplacer yields the find string verbatim', () => {
        const results = [...SimpleReplacer('some content', 'needle')];
        expect(results).toEqual(['needle']);
    });

    it('MultiOccurrenceReplacer yields one candidate per occurrence', () => {
        const results = [...MultiOccurrenceReplacer('a x a y a', 'a')];
        expect(results).toEqual(['a', 'a', 'a']);
    });

    it('LineTrimmedReplacer matches content with different leading whitespace', () => {
        const content = '  hello\n  world';
        const results = [...LineTrimmedReplacer(content, 'hello\nworld')];
        expect(results).toContain('  hello\n  world');
    });

    it('WhitespaceNormalizedReplacer collapses internal whitespace', () => {
        const content = 'foo     bar';
        const results = [...WhitespaceNormalizedReplacer(content, 'foo bar')];
        expect(results).toContain('foo     bar');
    });

    it('IndentationFlexibleReplacer strips common minimum indent', () => {
        const content = 'line0\n    hello\n    world\nline3';
        const results = [...IndentationFlexibleReplacer(content, 'hello\nworld')];
        expect(results).toContain('    hello\n    world');
    });

    it('EscapeNormalizedReplacer decodes backslash escapes', () => {
        const results = [...EscapeNormalizedReplacer('tab\there', 'tab\\there')];
        expect(results).toContain('tab\there');
    });

    it('TrimmedBoundaryReplacer yields trimmed find when it differs from find', () => {
        const results = [...TrimmedBoundaryReplacer('value', '  value  ')];
        expect(results).toContain('value');
    });

    it('TrimmedBoundaryReplacer yields nothing when find is already trimmed', () => {
        const results = [...TrimmedBoundaryReplacer('value', 'value')];
        expect(results).toEqual([]);
    });

    it('BlockAnchorReplacer requires at least 3 lines', () => {
        const results = [...BlockAnchorReplacer('a\nb', 'a\nb')];
        expect(results).toEqual([]);
    });

    it('BlockAnchorReplacer matches drifted middle content via anchors', () => {
        const content = 'function f() {\n  return 42;\n  // extra\n}';
        const results = [...BlockAnchorReplacer(content, 'function f() {\n  return 99;\n}')];
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]).toContain('function f()');
    });

    it('ContextAwareReplacer requires at least 3 lines', () => {
        const results = [...ContextAwareReplacer('a\nb', 'a\nb')];
        expect(results).toEqual([]);
    });

    it('ContextAwareReplacer yields blocks with matching first/last and 50% middle', () => {
        const content = 'begin\n  shared\n  different\nend\nrest';
        const results = [...ContextAwareReplacer(content, 'begin\n  shared\n  other\nend')];
        expect(results).toContain('begin\n  shared\n  different\nend');
    });
});

describe('renderUnifiedDiff', () => {
    it('produces a unified diff with removal and addition lines', () => {
        const diff = renderUnifiedDiff('test.txt', 'hello\nworld', 'hello\nearth');
        expect(diff).toContain('test.txt');
        expect(diff).toContain('-world');
        expect(diff).toContain('+earth');
    });

    it('produces no diff hunks for identical content', () => {
        const diff = renderUnifiedDiff('same.txt', 'no change', 'no change');
        expect(diff).toContain('same.txt');
        expect(diff).not.toMatch(/^@@/m);
    });
});
