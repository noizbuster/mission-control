import type { FiletypeParserOptions, SimpleHighlight, SyntaxStyle, TextChunk, TreeSitterClient } from '@opentui/core';
import { infoStringToFiletype, RGBA } from '@opentui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// clearRenderCache is mocked so we can assert the render LRU is invalidated on
// a successful async fill. Only `clearRenderCache` is consumed by the module
// under test, so the partial factory is sufficient.
vi.mock('./render-cache.js', () => ({ clearRenderCache: vi.fn() }));

import { clearRenderCache } from './render-cache.js';
import {
    closeTreeSitterClient,
    getHighlightVersion,
    type HighlighterRuntime,
    highlightTreeSitter,
    monochrome,
    resetHighlighterForTest,
    setHighlighterRuntime,
    subscribeHighlight,
} from './tree-sitter-highlighter.js';

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
 * chunk assertions exercise the real decode path.
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
function isMonochrome(
    lines: readonly { readonly spans: ReadonlyArray<{ readonly style: { readonly color?: string } }> }[],
): boolean {
    return lines.every((line) => line.spans.every((span) => span.style.color === undefined));
}

beforeEach(() => {
    vi.clearAllMocks();
    resetHighlighterForTest();
});

describe('monochrome', () => {
    it('produces one line per source line, each with a single unstyled span', () => {
        const lines = monochrome('a\nb\n');
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            expect(line.spans).toHaveLength(1);
            expect(line.spans[0]?.style).toStrictEqual({});
        }
    });
});

describe('highlightTreeSitter - sync entry point', () => {
    it('returns monochrome synchronously on a cache miss, then colored after the async fill', async () => {
        const fg = RGBA.fromHex('#ff0000');
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'const x', fg }],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        const first = highlightTreeSitter('const x', 'ts');
        expect(isMonochrome(first)).toBe(true);

        await flushPending();

        const second = highlightTreeSitter('const x', 'ts');
        expect(isMonochrome(second)).toBe(false);
        expect(second[0]?.spans[0]?.style.color).toBe('#ff0000');
    });

    it('resolves the fence alias to a filetype and passes both to highlightOnce', async () => {
        expect(infoStringToFiletype('ts')).toBe('typescript');
        const { runtime, highlightOnce } = setupMockRuntime({ chunks: [] });
        setHighlighterRuntime(runtime);

        highlightTreeSitter('const x', 'ts');
        await flushPending();

        expect(highlightOnce).toHaveBeenCalledWith('const x', 'typescript');
    });

    it('initializes the worker exactly once across multiple calls', async () => {
        const { runtime, setDataPath, registerParsers, buildSyntaxStyle } = setupMockRuntime({ chunks: [] });
        setHighlighterRuntime(runtime);

        highlightTreeSitter('const a', 'ts');
        highlightTreeSitter('const b', 'ts');
        await flushPending();

        expect(setDataPath).toHaveBeenCalledTimes(1);
        expect(registerParsers).toHaveBeenCalledTimes(1);
        expect(buildSyntaxStyle).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent parses for the same (code, lang)', async () => {
        const { runtime, highlightOnce } = setupMockRuntime({ chunks: [] });
        setHighlighterRuntime(runtime);

        highlightTreeSitter('const x', 'ts');
        highlightTreeSitter('const x', 'ts');
        await flushPending();

        expect(highlightOnce).toHaveBeenCalledTimes(1);
    });

    it('returns monochrome and does not schedule for an unsupported language', async () => {
        const { runtime, highlightOnce } = setupMockRuntime({ chunks: [] });
        setHighlighterRuntime(runtime);

        const result = highlightTreeSitter('x', 'totally-fake-lang');
        expect(isMonochrome(result)).toBe(true);
        await flushPending();
        expect(highlightOnce).not.toHaveBeenCalled();
    });

    it('returns monochrome and does not schedule when lang is undefined', async () => {
        const { runtime, highlightOnce } = setupMockRuntime({ chunks: [] });
        setHighlighterRuntime(runtime);

        const result = highlightTreeSitter('x');
        expect(isMonochrome(result)).toBe(true);
        await flushPending();
        expect(highlightOnce).not.toHaveBeenCalled();
    });

    it('stays monochrome when highlightOnce resolves with an error (no cache write)', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'const x', fg: RGBA.fromHex('#00ff00') }],
            highlightResult: { error: 'boom' },
        });
        setHighlighterRuntime(runtime);

        const first = highlightTreeSitter('const x', 'ts');
        await flushPending();

        const second = highlightTreeSitter('const x', 'ts');
        expect(isMonochrome(second)).toBe(true);
        expect(isMonochrome(first)).toBe(true);
    });
});

describe('chunksToLines - multiline split', () => {
    it('produces one HighlightedLine per input source line for a chunk spanning newlines', async () => {
        const fg = RGBA.fromHex('#82aaff');
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'a\nb\nc', fg }],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        highlightTreeSitter('a\nb\nc', 'ts');
        await flushPending();

        const result = highlightTreeSitter('a\nb\nc', 'ts');
        expect(result).toHaveLength(3);
        for (const line of result) {
            expect(line.spans).toHaveLength(1);
            expect(line.spans[0]?.style.color).toBe('#82aaff');
        }
    });
});

describe('version emitter', () => {
    it('notifies subscribers and increments the version after an async fill', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'x', fg: RGBA.fromHex('#ff0000') }],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        const versionBefore = getHighlightVersion();
        let notified = 0;
        const unsubscribe = subscribeHighlight(() => {
            notified += 1;
        });

        highlightTreeSitter('x', 'ts');
        await flushPending();

        expect(notified).toBeGreaterThanOrEqual(1);
        expect(getHighlightVersion()).toBeGreaterThan(versionBefore);
        unsubscribe();
    });

    it('subscribeHighlight returns an unsubscribe that stops notifications', async () => {
        const { runtime } = setupMockRuntime({ chunks: [], highlightResult: { highlights: [] } });
        setHighlighterRuntime(runtime);

        let notified = 0;
        const unsubscribe = subscribeHighlight(() => {
            notified += 1;
        });
        unsubscribe();

        highlightTreeSitter('y', 'ts');
        await flushPending();

        expect(notified).toBe(0);
    });
});

describe('render-cache invalidation', () => {
    it('calls clearRenderCache once after a successful fill', async () => {
        const { runtime } = setupMockRuntime({
            chunks: [{ __isChunk: true, text: 'const z', fg: RGBA.fromHex('#ff0000') }],
            highlightResult: { highlights: [] },
        });
        setHighlighterRuntime(runtime);

        highlightTreeSitter('const z', 'ts');
        await flushPending();

        expect(clearRenderCache).toHaveBeenCalledTimes(1);
    });

    it('does not call clearRenderCache when the fill errors', async () => {
        const { runtime } = setupMockRuntime({ highlightResult: { error: 'fail' } });
        setHighlighterRuntime(runtime);

        highlightTreeSitter('const z', 'ts');
        await flushPending();

        expect(clearRenderCache).not.toHaveBeenCalled();
    });
});

describe('closeTreeSitterClient', () => {
    it('destroys the client via the runtime seam and is idempotent', async () => {
        const destroySpy = vi.fn((): Promise<void> => Promise.resolve());
        const runtime: HighlighterRuntime = {
            getClient: () => ({ setDataPath: vi.fn(), highlightOnce: vi.fn() }) as unknown as TreeSitterClient,
            destroyClient: destroySpy,
            buildSyntaxStyle: () => ({ destroy: vi.fn() }) as unknown as SyntaxStyle,
            resolveDataPath: () => '/tmp/mctrl-test-data-dir',
            registerParsers: () => {},
            toTextChunks: () => [],
            filetypeFromInfoString: () => undefined,
        };
        setHighlighterRuntime(runtime);

        await closeTreeSitterClient();
        await closeTreeSitterClient();

        expect(destroySpy).toHaveBeenCalledTimes(2);
    });
});
