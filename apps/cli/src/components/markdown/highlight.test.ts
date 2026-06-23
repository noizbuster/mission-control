import { highlight as cliHighlightSpy } from 'cli-highlight';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { highlightCode, monochrome } from './highlight.js';

// Wrap cli-highlight's `highlight` in a spy backed by the real implementation
// so the forced-throw fallback test can override it once without affecting the
// real-highlighting tests. `supportsLanguage` stays real.
vi.mock('cli-highlight', async (importOriginal) => {
    const actual = await importOriginal<typeof import('cli-highlight')>();
    return { ...actual, highlight: vi.fn(actual.highlight) };
});

describe('highlightCode token coloring', () => {
    beforeEach(() => {
        vi.mocked(cliHighlightSpy).mockClear();
    });

    it('gives the `const` keyword a different color than the `x` identifier', () => {
        const lines = highlightCode('const x: number = 1;', 'ts');
        const spans = lines.flatMap((line) => line.spans);
        const constSpan = spans.find((span) => span.text === 'const');
        const xSpan = spans.find((span) => span.text.includes('x'));
        expect(constSpan).toBeDefined();
        expect(xSpan).toBeDefined();
        expect(constSpan?.style.color).toBeTruthy();
        expect(constSpan?.style.color).not.toBe(xSpan?.style.color);
    });

    it('maps the keyword scope to a distinct color', () => {
        const spans = highlightCode('return x;', 'ts').flatMap((line) => line.spans);
        const keyword = spans.find((span) => span.text === 'return');
        expect(keyword?.style.color).toBe('magenta');
    });
});

describe('highlightCode fallbacks', () => {
    beforeEach(() => {
        vi.mocked(cliHighlightSpy).mockClear();
    });

    it('returns monochrome for an unsupported language without throwing', () => {
        const lines = highlightCode('anything goes here', 'totally-not-a-lang');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            for (const span of line.spans) {
                expect(span.style.color).toBeUndefined();
            }
        }
    });

    it('returns monochrome when cli-highlight throws', () => {
        vi.mocked(cliHighlightSpy).mockImplementationOnce(() => {
            throw new Error('forced highlighter failure');
        });
        const lines = highlightCode('const x = 1;', 'ts');
        for (const line of lines) {
            for (const span of line.spans) {
                expect(span.style.color).toBeUndefined();
            }
        }
    });
});

describe('highlightCode no-raw-ANSI invariant', () => {
    it('never leaves a raw SGR escape sequence in any span text', () => {
        const samples = [
            'const x: number = 1;',
            'function greet(name: string): void { return "hi"; }',
            'class Foo<T> extends Bar { method() { return 42; } }',
            '#!/bin/bash\nVAR=hi\necho $VAR',
            '{"name": "x", "v": 1}',
        ];
        for (const code of samples) {
            const spans = highlightCode(code, 'ts').flatMap((line) => line.spans);
            for (const span of spans) {
                expect(span.text).not.toContain('\x1b[');
            }
        }
    });
});

describe('highlightCode line structure', () => {
    it('emits one HighlightedLine per input source line', () => {
        const code = 'const a = 1;\nconst b = 2;\nconst c = 3;';
        const lines = highlightCode(code, 'ts');
        expect(lines.length).toBe(3);
    });

    it('monochrome splits one span per line', () => {
        const lines = monochrome('a\nb\nc');
        expect(lines.length).toBe(3);
        for (const line of lines) {
            expect(line.spans.length).toBe(1);
            expect(line.spans[0]?.style.color).toBeUndefined();
        }
    });
});
