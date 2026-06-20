import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WebSearchInput } from './web-search-schemas.js';
import { executeWebSearch, selectWebSearchProvider, type WebSearchTransportOptions } from './web-search-transport.js';

describe('selectWebSearchProvider', () => {
    const previousExa = process.env['EXA_API_KEY'];
    const previousParallel = process.env['PARALLEL_API_KEY'];

    beforeEach(() => {
        delete process.env['EXA_API_KEY'];
        delete process.env['PARALLEL_API_KEY'];
    });

    afterEach(() => {
        restoreEnv('EXA_API_KEY', previousExa);
        restoreEnv('PARALLEL_API_KEY', previousParallel);
    });

    it('returns exa when EXA_API_KEY is set', () => {
        process.env['EXA_API_KEY'] = 'exa-test-key';
        expect(selectWebSearchProvider()).toBe('exa');
    });

    it('returns parallel when only PARALLEL_API_KEY is set', () => {
        process.env['PARALLEL_API_KEY'] = 'parallel-test-key';
        expect(selectWebSearchProvider()).toBe('parallel');
    });

    it('returns undefined when neither key is set', () => {
        expect(selectWebSearchProvider()).toBeUndefined();
    });

    it('prefers exa when both keys are set', () => {
        process.env['EXA_API_KEY'] = 'exa-test-key';
        process.env['PARALLEL_API_KEY'] = 'parallel-test-key';
        expect(selectWebSearchProvider()).toBe('exa');
    });

    function restoreEnv(name: string, value: string | undefined): void {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
});

describe('executeWebSearch', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        process.env['EXA_API_KEY'] = 'exa-test-key';
        process.env['PARALLEL_API_KEY'] = 'parallel-test-key';
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        delete process.env['EXA_API_KEY'];
        delete process.env['PARALLEL_API_KEY'];
        vi.useRealTimers();
    });

    const sampleInput: WebSearchInput = { query: 'test query' };
    const exaOptions: WebSearchTransportOptions = {
        provider: 'exa',
        sessionId: 'session-test',
    };

    it('parses a direct JSON MCP response into structured results', async () => {
        globalThis.fetch = jsonFetch(
            JSON.stringify({
                result: {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify([
                                { title: 'Result A', url: 'https://a.test', score: 0.9 },
                                { title: 'Result B', url: 'https://b.test', content: 'body b' },
                            ]),
                        },
                    ],
                },
            }),
        );

        const output = await executeWebSearch(sampleInput, exaOptions);

        expect(output.provider).toBe('exa');
        expect(output.results).toHaveLength(2);
        expect(output.results[0]?.title).toBe('Result A');
        expect(output.results[0]?.url).toBe('https://a.test');
        expect(output.results[0]?.score).toBe(0.9);
        expect(output.results[1]?.content).toBe('body b');
    });

    it('parses an SSE stream response by scanning data: lines', async () => {
        const envelope = JSON.stringify({
            result: {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify([{ title: 'SSE', url: 'https://sse.test' }]),
                    },
                ],
            },
        });
        const sseBody = ['event: message', `data: ${envelope}`, '', ''].join('\n');

        globalThis.fetch = jsonFetch(sseBody);

        const output = await executeWebSearch(sampleInput, exaOptions);

        expect(output.results).toHaveLength(1);
        expect(output.results[0]?.title).toBe('SSE');
        expect(output.results[0]?.url).toBe('https://sse.test');
    });

    it('returns an empty results array when the content payload is empty', async () => {
        globalThis.fetch = jsonFetch(
            JSON.stringify({
                result: { content: [{ type: 'text', text: '[]' }] },
            }),
        );

        const output = await executeWebSearch(sampleInput, exaOptions);

        expect(output.results).toHaveLength(0);
    });

    it('throws when the provider returns a non-ok HTTP status', async () => {
        globalThis.fetch = jsonFetch('internal error', 500);

        await expect(executeWebSearch(sampleInput, exaOptions)).rejects.toThrow(/HTTP 500/);
    });

    it('throws a timeout error after the 25s deadline elapses', async () => {
        vi.useFakeTimers();
        globalThis.fetch = hangingFetch;

        // Handler must attach before advancing timers, else the abort rejection lands during the flush as unhandled.
        const expectation = expect(executeWebSearch(sampleInput, exaOptions)).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(25_000);
        await expectation;
    });

    it('builds parallel provider args with objective and search_queries', async () => {
        let capturedBody = '';
        const capturingFetch: typeof globalThis.fetch = (_input, init) => {
            if (init?.body !== undefined) capturedBody = String(init.body);
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        result: { content: [{ type: 'text', text: '[]' }] },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            );
        };
        globalThis.fetch = capturingFetch;

        await executeWebSearch(sampleInput, {
            provider: 'parallel',
            sessionId: 'session-parallel',
        });

        const parsed = captureSchema.parse(JSON.parse(capturedBody));
        expect(parsed.params.name).toBe('web_search');
        expect(parsed.params.arguments['objective']).toBe('test query');
        expect(parsed.params.arguments['search_queries']).toEqual(['test query']);
        expect(parsed.params.arguments['session_id']).toBe('session-parallel');
        expect(parsed.params.arguments['model_name']).toBe('auto');
    });

    function jsonFetch(body: string, status = 200): typeof globalThis.fetch {
        return () =>
            Promise.resolve(
                new Response(body, {
                    status,
                    headers: { 'content-type': 'application/json' },
                }),
            );
    }

    function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
    }
});

const captureSchema = z.object({
    params: z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
    }),
});
