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

        it('returns the first line when it is a clean token', () => {
            expect(parseStructuredOutput('APPROVE\n(because all critics passed)')).toEqual({
                ok: true,
                value: 'APPROVE',
            });
        });

        it('keeps a plain category label as a string', () => {
            expect(parseStructuredOutput('trivial')).toEqual({ ok: true, value: 'trivial' });
        });

        it('extracts the last line when reasoning precedes the classification', () => {
            const verbose = [
                'Intent: **explicit-implementation**',
                '',
                'Reasoning: The user asks for a concrete fix with clear scope.',
                '',
                'explicit-implementation',
            ].join('\n');
            expect(parseStructuredOutput(verbose)).toEqual({
                ok: true,
                value: 'explicit-implementation',
            });
        });

        it('extracts the last line for a multi-class verbose output', () => {
            const verbose = 'After analysis, this is exploratory.\n\nexploratory-research';
            expect(parseStructuredOutput(verbose)).toEqual({
                ok: true,
                value: 'exploratory-research',
            });
        });

        it('coerces last-line "true" to boolean from multi-line verbose output', () => {
            const verbose = 'The anti-dup check passes. No prior exploration duplicated.\n\ntrue';
            expect(parseStructuredOutput(verbose, 'boolean')).toEqual({
                ok: true,
                value: true,
            });
        });

        it('coerces last-line "false" to boolean from multi-line verbose output', () => {
            const verbose = 'Evidence is insufficient. Tests not passing.\n\nfalse';
            expect(parseStructuredOutput(verbose, 'boolean')).toEqual({
                ok: true,
                value: false,
            });
        });

        it('coerces bare last-line true without expectedShape', () => {
            const verbose = 'Reasoning here.\n\ntrue';
            expect(parseStructuredOutput(verbose)).toEqual({
                ok: true,
                value: true,
            });
        });
    });

    describe('natural-language boolean tokens', () => {
        it('parses bare yes as boolean true', () => {
            expect(parseStructuredOutput('yes', 'boolean')).toEqual({ ok: true, value: true });
        });

        it('parses bare no as boolean false', () => {
            expect(parseStructuredOutput('no', 'boolean')).toEqual({ ok: true, value: false });
        });

        it('parses a key=value assignment on the last line as boolean', () => {
            const verbose = 'Both checks pass, delegation is appropriate.\n\nguard.cleared=true';
            expect(parseStructuredOutput(verbose, 'boolean')).toEqual({ ok: true, value: true });
        });

        it('parses a key: false assignment as boolean false', () => {
            const verbose = 'Evidence is insufficient.\n\nguard.cleared: false';
            expect(parseStructuredOutput(verbose, 'boolean')).toEqual({ ok: true, value: false });
        });

        it('parses key=yes as boolean true', () => {
            expect(parseStructuredOutput('guard.cleared=yes', 'boolean')).toEqual({ ok: true, value: true });
        });

        it('does not coerce a sentence containing yes as substring', () => {
            const result = parseStructuredOutput('Let me find the files.', 'boolean');
            expect(result.ok).toBe(false);
        });

        it('parses yes with expectedShape any as boolean', () => {
            expect(parseStructuredOutput('yes')).toEqual({ ok: true, value: true });
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
