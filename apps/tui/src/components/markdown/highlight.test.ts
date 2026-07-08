import type { FiletypeParserOptions, SimpleHighlight, SyntaxStyle, TextChunk, TreeSitterClient } from '@opentui/core';
import { RGBA } from '@opentui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// clearRenderCache is mocked so the async-fill path never touches the real
// markdown render LRU. Only `clearRenderCache` is consumed transitively by the
// module under test, so the partial factory is sufficient.
vi.mock('./render-cache.js', () => ({ clearRenderCache: vi.fn() }));

import type { HighlightedLine } from './highlight.js';
import { getHighlightVersion, highlightCode, monochrome, subscribeHighlight } from './highlight.js';
import { type HighlighterRuntime, resetHighlighterForTest, setHighlighterRuntime } from './tree-sitter-highlighter.js';

/**
 * Controls returned by {@link setupMockRuntime}. Each spy mirrors one boundary
 * the orchestrator reaches through the {@link HighlighterRuntime} seam.
 */
type MockControls = {
    readonly runtime: HighlighterRuntime;
    readonly setDataPath: ReturnType<typeof vi.fn>;
    readonly highlightOnce: ReturnType<typeof vi.fn>;
    readonly registerParsers: ReturnType<typeof vi.fn>;
    readonly destroyClient: ReturnType<typeof vi.fn>;
    readonly buildSyntaxStyle: ReturnType<typeof vi.fn>;
    readonly toTextChunks: ReturnType<typeof vi.fn>;
};

interface MockOptions {
    /** What highlightOnce resolves with. Defaults to `{ highlights: [] }`. */
    readonly highlightResult?: { readonly highlights?: SimpleHighlight[]; readonly error?: string };
    /** Canned TextChunks returned by toTextChunks. Defaults to `[]`. */
    readonly chunks?: readonly TextChunk[];
}

/**
 * Build a fully-mocked runtime. The client, style, and chunk converter are all
 * fakes, so no opentui worker, native core, or network is touched. `RGBA` /
 * `rgbToHex` stay real (imported transitively by text-attributes) so colored
 * chunk assertions exercise the real decode path. Pattern reused verbatim from
 * `tree-sitter-highlighter.test.ts`.
 */
function setupMockRuntime(options: MockOptions = {}): MockControls {
    const setDataPath = vi.fn((_path: string): Promise<void> => Promise.resolve());
    const highlightOnce = vi.fn(
        (
            _content: string,
            _filetype: string,
        ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> => {
            if (options.highlightResult?.error !== undefined) {
                return Promise.resolve({ error: options.highlightResult.error });
            }
            return Promise.resolve({ highlights: options.highlightResult?.highlights ?? [] });
        },
    );
    const registerParsers = vi.fn((_parsers: readonly FiletypeParserOptions[]): void => {});
    const destroyClient = vi.fn((): Promise<void> => Promise.resolve());
    const buildSyntaxStyle = vi.fn((): SyntaxStyle => ({ destroy: vi.fn() }) as unknown as SyntaxStyle);
    const toTextChunks = vi.fn((_content: string): TextChunk[] => [...(options.chunks ?? [])]);

    // The mock client only needs setDataPath + highlightOnce, which the
    // orchestrator reaches. The cast is test-only over a class with private
    // native-backed fields that cannot be constructed without the FFI backend.
    const mockClient = { setDataPath, highlightOnce } as unknown as TreeSitterClient;

    const runtime: HighlighterRuntime = {
        getClient: () => mockClient,
        destroyClient,
        buildSyntaxStyle,
        resolveDataPath: () => '/tmp/mctrl-test-data-dir',
        registerParsers,
        toTextChunks: (content) => toTextChunks(content),
        filetypeFromInfoString: (infoString) => (infoString === 'ts' ? 'typescript' : undefined),
    };

    return { runtime, setDataPath, highlightOnce, registerParsers, destroyClient, buildSyntaxStyle, toTextChunks };
}

/**
 * Flush pending microtasks until the async fill chain (init -> highlightOnce ->
 * process) settles. Each `setImmediate` boundary drains the microtask queue.
 */
async function flushPending(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

/** True when every span on every line lacks a `color` (monochrome). */
function isMonochrome(lines: readonly HighlightedLine[]): boolean {
    return lines.every((line) => line.spans.every((span) => span.style.fg === undefined));
}

beforeEach(() => {
    vi.clearAllMocks();
    resetHighlighterForTest();
});

describe('highlightCode token coloring', () => {
    it('gives the `const` keyword a different color than the `x` identifier', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [
                { __isChunk: true, text: 'const', fg: RGBA.fromHex('#c792ea') },
                { __isChunk: true, text: ' x' },
            ],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        highlightCode('const x: number = 1;', 'ts');
        await flushPending();

        const spans = highlightCode('const x: number = 1;', 'ts').flatMap((line) => line.spans);
        const constSpan = spans.find((span) => span.text === 'const');
        const xSpan = spans.find((span) => span.text.includes('x'));
        expect(constSpan).toBeDefined();
        expect(xSpan).toBeDefined();
        expect(constSpan?.style.fg).toBeTruthy();
        expect(constSpan?.style.fg).not.toBe(xSpan?.style.fg);
    });

    it('maps the keyword scope to a distinct color', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [
                { __isChunk: true, text: 'return', fg: RGBA.fromHex('#c792ea') },
                { __isChunk: true, text: ' x;' },
            ],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        highlightCode('return x;', 'ts');
        await flushPending();

        const spans = highlightCode('return x;', 'ts').flatMap((line) => line.spans);
        const keyword = spans.find((span) => span.text === 'return');
        expect(keyword?.style.fg).toBeTruthy();
    });
});

describe('highlightCode fallbacks', () => {
    it('returns monochrome for an unsupported language without throwing', () => {
        const { runtime } = setupMockRuntime({ chunks: [] });
        setHighlighterRuntime(runtime);

        const lines = highlightCode('anything goes here', 'totally-not-a-lang');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            for (const span of line.spans) {
                expect(span.style.fg).toBeUndefined();
            }
        }
    });

    it('returns monochrome and writes no cache when highlightOnce errors', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'const x', fg: RGBA.fromHex('#c792ea') }],
            highlightResult: { error: 'forced' },
        });
        setHighlighterRuntime(runtime);

        highlightCode('const x = 1;', 'ts');
        await flushPending();

        const lines = highlightCode('const x = 1;', 'ts');
        expect(isMonochrome(lines)).toBe(true);
    });
});

describe('highlightCode no-raw-ANSI invariant', () => {
    it('never leaves a raw SGR escape sequence in any span text', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'const x\nfunction y', fg: RGBA.fromHex('#c792ea') }],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        const samples = [
            'const x: number = 1;',
            'function greet(name: string): void { return "hi"; }',
            'class Foo<T> extends Bar { method() { return 42; } }',
        ];
        for (const code of samples) {
            highlightCode(code, 'ts');
        }
        await flushPending();

        for (const code of samples) {
            const spans = highlightCode(code, 'ts').flatMap((line) => line.spans);
            for (const span of spans) {
                expect(span.text).not.toContain('\x1b[');
            }
        }
    });
});

describe('highlightCode line structure', () => {
    it('emits one HighlightedLine per input source line', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [
                { __isChunk: true, text: 'const a = 1;\nconst b = 2;\nconst c = 3;', fg: RGBA.fromHex('#c792ea') },
            ],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        const code = 'const a = 1;\nconst b = 2;\nconst c = 3;';
        highlightCode(code, 'ts');
        await flushPending();

        const lines = highlightCode(code, 'ts');
        expect(lines.length).toBe(3);
    });

    it('monochrome splits one span per line', () => {
        const lines: readonly HighlightedLine[] = monochrome('a\nb\nc');
        expect(lines.length).toBe(3);
        for (const line of lines) {
            expect(line.spans.length).toBe(1);
            expect(line.spans[0]?.style.fg).toBeUndefined();
        }
    });
});

describe('highlightCode async fill', () => {
    it('returns monochrome synchronously on a miss, then colored after the fill', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'const x', fg: RGBA.fromHex('#c792ea') }],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        const first = highlightCode('const x', 'ts');
        expect(isMonochrome(first)).toBe(true);

        await flushPending();

        const second = highlightCode('const x', 'ts');
        expect(isMonochrome(second)).toBe(false);
        const colored = second.some((line) => line.spans.some((span) => span.style.fg !== undefined));
        expect(colored).toBe(true);
    });

    it('notifies subscribers and increments the version after an async fill', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'x', fg: RGBA.fromHex('#c792ea') }],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        const versionBefore = getHighlightVersion();
        let notified = 0;
        const unsubscribe = subscribeHighlight(() => {
            notified += 1;
        });

        highlightCode('x', 'ts');
        await flushPending();

        expect(notified).toBeGreaterThanOrEqual(1);
        expect(getHighlightVersion()).toBeGreaterThan(versionBefore);
        unsubscribe();
    });
});
