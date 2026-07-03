import { describe, expect, it } from 'vitest';
import { parseStructuredOutput, SUPPORTED_OUTPUT_KEYS } from './structured-blackboard.js';

describe('parseStructuredOutput', () => {
    describe('bare JSON', () => {
        it('parses a bare JSON object', () => {
            expect(parseStructuredOutput('{"class":"explicit"}')).toEqual({
                ok: true,
                value: { class: 'explicit' },
            });
        });

        it('parses a bare JSON array', () => {
            const result = parseStructuredOutput('[{"id":"a"},{"id":"b"}]');
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toEqual([{ id: 'a' }, { id: 'b' }]);
            }
        });

        it('parses bare JSON with surrounding whitespace', () => {
            expect(parseStructuredOutput('  \n  {"k":1}  \n  ')).toEqual({ ok: true, value: { k: 1 } });
        });

        it('fails closed on malformed JSON starting with an object brace', () => {
            const result = parseStructuredOutput('{"class":"explicit"');
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('invalid JSON');
            }
        });

        it('fails closed on malformed JSON starting with an array bracket', () => {
            expect(parseStructuredOutput('[1,2,').ok).toBe(false);
        });
    });

    describe('fenced JSON', () => {
        it('parses a json-fenced object', () => {
            expect(parseStructuredOutput('```json\n{"class":"explicit"}\n```')).toEqual({
                ok: true,
                value: { class: 'explicit' },
            });
        });

        it('parses a plain-fenced object with no language tag', () => {
            expect(parseStructuredOutput('```\n{"k":1}\n```')).toEqual({ ok: true, value: { k: 1 } });
        });

        it('parses a json-fenced array', () => {
            const result = parseStructuredOutput('```json\n[1,2,3]\n```');
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toEqual([1, 2, 3]);
            }
        });

        it('extracts the fenced block when surrounded by prose', () => {
            const result = parseStructuredOutput('Here is the plan:\n```json\n{"ready":true}\n```\nDone.');
            expect(result).toEqual({ ok: true, value: { ready: true } });
        });

        it('fails closed on invalid fenced JSON', () => {
            expect(parseStructuredOutput('```json\n{not valid}\n```').ok).toBe(false);
        });
    });

    describe('plain boolean', () => {
        it('parses true', () => {
            expect(parseStructuredOutput('true')).toEqual({ ok: true, value: true });
        });

        it('parses false', () => {
            expect(parseStructuredOutput('false')).toEqual({ ok: true, value: false });
        });

        it('parses a boolean with surrounding whitespace', () => {
            expect(parseStructuredOutput('  true  ')).toEqual({ ok: true, value: true });
        });
    });

    describe('single-line string (backwards compat)', () => {
        it('parses a bare single-line string', () => {
            expect(parseStructuredOutput('explicit')).toEqual({ ok: true, value: 'explicit' });
        });

        it('returns the first line of multi-line prose', () => {
            expect(parseStructuredOutput('APPROVE\n(because all critics passed)')).toEqual({
                ok: true,
                value: 'APPROVE',
            });
        });

        it('keeps a plain category label as a string', () => {
            expect(parseStructuredOutput('trivial')).toEqual({ ok: true, value: 'trivial' });
        });
    });

    describe('fail-closed edge cases', () => {
        it('fails closed on empty input', () => {
            expect(parseStructuredOutput('')).toEqual({ ok: false, error: 'empty output' });
        });

        it('fails closed on whitespace-only input', () => {
            expect(parseStructuredOutput('   \n  ')).toEqual({ ok: false, error: 'empty output' });
        });
    });

    describe('expectedShape validation', () => {
        it('accepts an object when expectedShape is object', () => {
            expect(parseStructuredOutput('{"k":1}', 'object')).toEqual({ ok: true, value: { k: 1 } });
        });

        it('rejects a string when expectedShape is object', () => {
            const result = parseStructuredOutput('hello', 'object');
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('object');
            }
        });

        it('accepts an array when expectedShape is array', () => {
            expect(parseStructuredOutput('[1,2]', 'array').ok).toBe(true);
        });

        it('rejects an object when expectedShape is array', () => {
            expect(parseStructuredOutput('{"k":1}', 'array').ok).toBe(false);
        });

        it('accepts a boolean when expectedShape is boolean', () => {
            expect(parseStructuredOutput('true', 'boolean')).toEqual({ ok: true, value: true });
        });

        it('rejects a non-boolean string when expectedShape is boolean', () => {
            expect(parseStructuredOutput('true-ish', 'boolean').ok).toBe(false);
        });

        it('accepts a string when expectedShape is string', () => {
            expect(parseStructuredOutput('APPROVE', 'string')).toEqual({ ok: true, value: 'APPROVE' });
        });

        it('defaults to any and accepts every parseable form', () => {
            expect(parseStructuredOutput('{"k":1}').ok).toBe(true);
            expect(parseStructuredOutput('true').ok).toBe(true);
            expect(parseStructuredOutput('hello').ok).toBe(true);
        });
    });

    describe('SUPPORTED_OUTPUT_KEYS vocabulary', () => {
        it('documents all nine required output keys', () => {
            expect([...SUPPORTED_OUTPUT_KEYS]).toEqual([
                'intent.classification',
                'plan.todos',
                'plan.ready',
                'wave.tasks',
                'wave.pending',
                'delegate.results',
                'verify.complete',
                'checkbox.updated',
                'final.verdict',
            ]);
        });
    });
});
