import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolExecutionError, ToolRegistry } from './tool-registry.js';
import { type WebSearchInput, type WebSearchOutput, webSearchParametersJsonSchema } from './web-search-schemas.js';
import {
    createWebSearchToolRegistration,
    registerWebSearchTool,
    type WebSearchToolOptions,
} from './web-search-tool.js';

describe('web_search tool', () => {
    const previousExa = process.env['EXA_API_KEY'];
    const previousParallel = process.env['PARALLEL_API_KEY'];
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        delete process.env['EXA_API_KEY'];
        delete process.env['PARALLEL_API_KEY'];
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        restoreEnv('EXA_API_KEY', previousExa);
        restoreEnv('PARALLEL_API_KEY', previousParallel);
    });

    const options: WebSearchToolOptions = { sessionId: 'session-test' };

    describe('createWebSearchToolRegistration', () => {
        it('produces a valid ToolRegistration with the web_search identity', () => {
            const registration = createWebSearchToolRegistration(options);

            expect(registration.name).toBe('web_search');
            expect(registration.capabilityClasses).toContain('network');
            expect(registration.description).toBe(
                'Search the web for real-time information. Returns relevant results with titles, URLs, and content snippets.',
            );
            expect(registration.outputLimit.maxModelOutputChars).toBe(10_000);
            expect(registration.guideline).toContain('web_search');
        });

        it('exposes the web search parameters JSON schema bound to the transport', () => {
            const registration = createWebSearchToolRegistration(options);

            expect(registration.parametersJsonSchema).toEqual(webSearchParametersJsonSchema());
        });

        it('binds input and output schemas from the shared contract', () => {
            const registration = createWebSearchToolRegistration(options);

            expect(registration.inputSchema.safeParse({ query: 'hello' }).success).toBe(true);
            expect(registration.inputSchema.safeParse({}).success).toBe(false);
            expect(registration.outputSchema.safeParse({ results: [], provider: 'exa' }).success).toBe(true);
        });
    });

    describe('registerWebSearchTool', () => {
        it('registers the tool and advertises the web_search name with network capability', async () => {
            const registry = new ToolRegistry();

            const advertisement = await registerWebSearchTool(registry, options);

            expect(advertisement.name).toBe('web_search');
            expect(advertisement.capabilityClasses).toContain('network');
            expect(advertisement.outputLimit.maxModelOutputChars).toBe(10_000);

            const advertised = registry.advertise().find((tool) => tool.name === 'web_search');
            expect(advertised).toBeDefined();
            expect(advertised?.capabilityClasses).toContain('network');
        });

        it('produces a stable version hash so repeated registrations agree', async () => {
            const registry = new ToolRegistry();

            const first = await registerWebSearchTool(registry, options);
            const second = createWebSearchToolRegistration(options);
            const secondRegistry = new ToolRegistry();
            const secondAd = secondRegistry.register(second);

            expect(secondAd.version).toBe(first.version);
        });
    });

    describe('execute', () => {
        it('throws a helpful ToolExecutionError when no provider is configured', async () => {
            const registration = createWebSearchToolRegistration(options);
            const input: WebSearchInput = { query: 'test query' };

            const caught = await captureError(() => registration.execute(input, executionContext()));

            expect(caught).toBeInstanceOf(ToolExecutionError);
            const toolError = caught as ToolExecutionError;
            expect(toolError.error.message).toContain('EXA_API_KEY');
            expect(toolError.error.message).toContain('PARALLEL_API_KEY');
            expect(toolError.error.retryable).toBe(false);
        });

        it('returns structured results when the transport succeeds with a valid MCP envelope', async () => {
            process.env['EXA_API_KEY'] = 'exa-test-key';
            globalThis.fetch = jsonFetch(
                JSON.stringify({
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify([
                                    { title: 'Result A', url: 'https://a.test', content: 'body a', score: 0.9 },
                                    { title: 'Result B', url: 'https://b.test' },
                                ]),
                            },
                        ],
                    },
                }),
            );

            const registration = createWebSearchToolRegistration(options);
            const output = await registration.execute({ query: 'hello' }, executionContext());

            expect(output.provider).toBe('exa');
            expect(output.results).toHaveLength(2);
            expect(output.results[0]?.title).toBe('Result A');
            expect(output.results[0]?.url).toBe('https://a.test');
            expect(output.results[0]?.content).toBe('body a');
            expect(output.results[0]?.score).toBe(0.9);
            expect(output.results[1]?.title).toBe('Result B');
        });

        it('wraps transport errors as retryable ToolExecutionError', async () => {
            process.env['EXA_API_KEY'] = 'exa-test-key';
            globalThis.fetch = jsonFetch('internal error', 500);

            const registration = createWebSearchToolRegistration(options);

            const caught = await captureError(() => registration.execute({ query: 'hello' }, executionContext()));

            expect(caught).toBeInstanceOf(ToolExecutionError);
            const toolError = caught as ToolExecutionError;
            expect(toolError.error.retryable).toBe(true);
            expect(toolError.error.message).toMatch(/HTTP 500/);
        });

        it('uses the parallel provider when only PARALLEL_API_KEY is set', async () => {
            process.env['PARALLEL_API_KEY'] = 'parallel-test-key';
            globalThis.fetch = jsonFetch(
                JSON.stringify({
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify([{ title: 'Parallel Result', url: 'https://p.test' }]),
                            },
                        ],
                    },
                }),
            );

            const registration = createWebSearchToolRegistration(options);
            const output = await registration.execute({ query: 'parallel query' }, executionContext());

            expect(output.provider).toBe('parallel');
            expect(output.results[0]?.title).toBe('Parallel Result');
        });
    });

    describe('toModelOutput', () => {
        it('formats each result with title, URL, and content', () => {
            const registration = createWebSearchToolRegistration(options);
            const output: WebSearchOutput = {
                provider: 'exa',
                results: [
                    { title: 'First', url: 'https://first.test', content: 'first body' },
                    { title: 'Second', url: 'https://second.test' },
                ],
            };

            const modelOutput = registration.toModelOutput?.(output) ?? '';

            expect(modelOutput).toContain('First');
            expect(modelOutput).toContain('https://first.test');
            expect(modelOutput).toContain('first body');
            expect(modelOutput).toContain('Second');
            expect(modelOutput).toContain('https://second.test');
        });

        it('reports an empty result set without crashing', () => {
            const registration = createWebSearchToolRegistration(options);

            const modelOutput = registration.toModelOutput?.({ provider: 'exa', results: [] }) ?? '';

            expect(modelOutput.length).toBeGreaterThan(0);
            expect(modelOutput).toContain('No results found');
        });
    });

    function executionContext() {
        return {
            toolCallId: 'web_search_call',
            toolName: 'web_search',
            signal: new AbortController().signal,
        };
    }

    function jsonFetch(body: string, status = 200): typeof globalThis.fetch {
        return () =>
            Promise.resolve(
                new Response(body, {
                    status,
                    headers: { 'content-type': 'application/json' },
                }),
            );
    }

    async function captureError(thunk: () => unknown | Promise<unknown>): Promise<unknown> {
        try {
            await thunk();
        } catch (error: unknown) {
            return error;
        }
        throw new Error('expected execute to throw');
    }

    function restoreEnv(name: string, value: string | undefined): void {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
});
