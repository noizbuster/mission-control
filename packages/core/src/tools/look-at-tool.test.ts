import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createInspectImageToolRegistration,
    type InspectImageInput,
    type InspectImageOutput,
} from './inspect-image-tool';
import {
    createLookAtToolRegistration,
    defaultVisionFetch,
    type LookAtInput,
    type LookAtOutput,
    type VisionFetchFn,
} from './look-at-tool';
import { ToolExecutionError, ToolRegistry } from './tool-registry';
import { resolveVisionProviderChain } from './vision-providers';
import { visionCredentialHint } from './vision-schemas';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VISION_ENV_KEYS = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    'ZAI_API_KEY',
    'ZHIPU_API_KEY',
] as const;

const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('vision tools (look_at + inspect_image)', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let originalFetch: typeof globalThis.fetch;
    let tmpDir: string;

    beforeEach(() => {
        for (const key of VISION_ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        originalFetch = globalThis.fetch;
        tmpDir = mkdtempSync(join(tmpdir(), 'vision-tools-'));
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        for (const key of VISION_ENV_KEYS) {
            if (savedEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = savedEnv[key];
            }
        }
    });

    function executionContext() {
        return {
            toolCallId: 'vision_call',
            toolName: 'look_at',
            signal: new AbortController().signal,
        };
    }

    function mockFetchReturning(analysis: string): VisionFetchFn {
        // URL-aware: return the response shape the targeted provider's parseResponse expects,
        // so a test that sets ANTHROPIC_API_KEY or GEMINI_API_KEY still parses cleanly.
        return async (request) => {
            const url = request.url;
            if (url.includes('anthropic.com')) {
                return { body: JSON.stringify({ content: [{ type: 'text', text: analysis }] }) };
            }
            if (url.includes('generativelanguage.googleapis.com')) {
                return {
                    body: JSON.stringify({
                        candidates: [{ content: { parts: [{ text: analysis }] } }],
                    }),
                };
            }
            return { body: JSON.stringify({ choices: [{ message: { content: analysis } }] }) };
        };
    }

    function mockFetchReturningEmpty(): VisionFetchFn {
        return async () => ({ body: JSON.stringify({ choices: [] }) });
    }

    // -------------------------------------------------------------------------
    // look_at registration shape
    // -------------------------------------------------------------------------

    describe('createLookAtToolRegistration', () => {
        it('produces a valid ToolRegistration with the look_at identity', () => {
            const registration = createLookAtToolRegistration();
            expect(registration.name).toBe('look_at');
            expect(registration.capabilityClasses).toContain('network');
            expect(registration.outputLimit.maxModelOutputChars).toBeGreaterThan(0);
            expect(registration.description.length).toBeGreaterThan(0);
            expect(registration.guideline).toContain('vision');
        });

        it('exposes a JSON schema declaring goal required plus the file/image inputs', () => {
            const registration = createLookAtToolRegistration();
            const schema = registration.parametersJsonSchema as Record<string, unknown>;
            const properties = schema['properties'] as Record<string, unknown>;
            const required = schema['required'] as string[];
            expect(properties['file_path']).toBeDefined();
            expect(properties['file_paths']).toBeDefined();
            expect(properties['image_data']).toBeDefined();
            expect(properties['image_data_list']).toBeDefined();
            expect(properties['goal']).toBeDefined();
            expect(required).toContain('goal');
        });

        it('produces a stable version hash so repeated registrations agree', () => {
            const first = createLookAtToolRegistration();
            const registry = new ToolRegistry();
            const firstAd = registry.register(first);
            const secondAd = new ToolRegistry().register(createLookAtToolRegistration());
            expect(secondAd.version).toBe(firstAd.version);
        });
    });

    // -------------------------------------------------------------------------
    // credential gate
    // -------------------------------------------------------------------------

    describe('credential gate', () => {
        it('resolves an empty chain when no vision credential is configured', () => {
            expect(resolveVisionProviderChain('auto')).toHaveLength(0);
        });

        it('throws a non-retryable ToolExecutionError listing the env vars when no credential is set', async () => {
            process.env['OPENAI_API_KEY'] = ''; // empty must NOT count as configured
            const registration = createLookAtToolRegistration();
            const input: LookAtInput = {
                image_data: TINY_PNG_BASE64,
                goal: 'describe the image',
            };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            const toolError = caught as ToolExecutionError;
            expect(toolError.error.retryable).toBe(false);
            expect(toolError.error.message).toContain('No vision provider credential');
            for (const token of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
                expect(toolError.error.message).toContain(token);
            }
            expect(visionCredentialHint()).toContain('OPENAI_API_KEY');
        });

        it('admits the openai provider once OPENAI_API_KEY is set', () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const chain = resolveVisionProviderChain('auto');
            expect(chain.map((provider) => provider.id)).toContain('openai');
        });
    });

    // -------------------------------------------------------------------------
    // look_at execute against a mocked vision provider
    // -------------------------------------------------------------------------

    describe('look_at execute', () => {
        it('returns a structured analysis when the transport succeeds (image_data)', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const registration = createLookAtToolRegistration({
                fetch: mockFetchReturning('A red square on a white background.'),
            });
            const input: LookAtInput = { image_data: TINY_PNG_BASE64, goal: 'describe the image' };
            const output = await registration.execute(input, executionContext() as never);
            expect(output.kind).toBe('look_at');
            expect(output.provider).toBe('auto');
            expect(output.sourceDescription).toBe('clipboard/pasted image');
            expect(output.analysis).toContain('red square');
            expect(output.truncated).toBe(false);
        });

        it('analyzes a file_path after reading it from disk', async () => {
            process.env['ANTHROPIC_API_KEY'] = 'ant-test';
            const filePath = join(tmpDir, 'chart.png');
            writeFileSync(filePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
            const registration = createLookAtToolRegistration({
                fetch: mockFetchReturning('A line chart trending up.'),
            });
            const input: LookAtInput = { file_path: filePath, goal: 'what is this chart' };
            const output = await registration.execute(input, executionContext() as never);
            expect(output.analysis).toContain('line chart');
            expect(output.sourceDescription).toBe(filePath);
        });

        it('analyzes multiple file_paths together', async () => {
            process.env['GEMINI_API_KEY'] = 'gem-test';
            const first = join(tmpDir, 'a.png');
            const second = join(tmpDir, 'b.png');
            writeFileSync(first, Buffer.from(TINY_PNG_BASE64, 'base64'));
            writeFileSync(second, Buffer.from(TINY_PNG_BASE64, 'base64'));
            const registration = createLookAtToolRegistration({
                fetch: mockFetchReturning('Two images were provided.'),
            });
            const input: LookAtInput = { file_paths: [first, second], goal: 'compare them' };
            const output = await registration.execute(input, executionContext() as never);
            expect(output.sourceDescription).toBe('2 files/images');
            expect(output.analysis).toContain('Two images');
        });

        it('strips a data: prefix on image_data before decoding', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const registration = createLookAtToolRegistration({
                fetch: mockFetchReturning('Tiny pixel.'),
            });
            const input: LookAtInput = {
                image_data: `data:image/png;base64,${TINY_PNG_BASE64}`,
                goal: 'describe',
            };
            const output = await registration.execute(input, executionContext() as never);
            expect(output.analysis).toBe('Tiny pixel.');
        });

        it('rejects remote URLs with a non-retryable error', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const registration = createLookAtToolRegistration({
                fetch: mockFetchReturning('should not reach'),
            });
            const input: LookAtInput = {
                file_path: 'https://example.test/image.png',
                goal: 'describe',
            };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.message).toContain('Remote URLs');
        });

        it('requires at least one input source', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const registration = createLookAtToolRegistration();
            const input: LookAtInput = { goal: 'describe' };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.message).toContain("either 'file_path'");
        });

        it('reports a missing file clearly', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const registration = createLookAtToolRegistration();
            const input: LookAtInput = {
                file_path: join(tmpDir, 'does-not-exist.png'),
                goal: 'describe',
            };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.message).toContain('File not found');
        });
    });

    // -------------------------------------------------------------------------
    // image-size cap
    // -------------------------------------------------------------------------

    describe('image-size cap', () => {
        it('rejects an image_data payload that exceeds the configured cap', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            // Build a base64 payload whose decoded length is larger than a tiny cap.
            const oversized = Buffer.alloc(1024, 0xff).toString('base64');
            const registration = createLookAtToolRegistration({
                maxImageBytes: 64,
                fetch: mockFetchReturning('should not reach'),
            });
            const input: LookAtInput = { image_data: oversized, goal: 'describe' };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.message).toContain('image-size cap');
        });

        it('rejects a file_path whose file exceeds the configured cap', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const filePath = join(tmpDir, 'big.png');
            writeFileSync(filePath, Buffer.alloc(2048, 0x00));
            const registration = createLookAtToolRegistration({
                maxImageBytes: 128,
                fetch: mockFetchReturning('should not reach'),
            });
            const input: LookAtInput = { file_path: filePath, goal: 'describe' };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.message).toContain('image-size cap');
        });
    });

    // -------------------------------------------------------------------------
    // provider preference + fallback
    // -------------------------------------------------------------------------

    describe('provider preference', () => {
        it('routes to the pinned provider when explicitly available', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            process.env['ANTHROPIC_API_KEY'] = 'ant-test';
            let capturedUrl = '';
            const fetchFn: VisionFetchFn = async (request) => {
                capturedUrl = request.url;
                const text = 'pinned response';
                if (request.url.includes('anthropic.com')) {
                    return { body: JSON.stringify({ content: [{ type: 'text', text }] }) };
                }
                return { body: JSON.stringify({ choices: [{ message: { content: text } }] }) };
            };
            const registration = createLookAtToolRegistration({
                providerPreference: 'anthropic',
                fetch: fetchFn,
            });
            const input: LookAtInput = { image_data: TINY_PNG_BASE64, goal: 'describe' };
            const output = await registration.execute(input, executionContext() as never);
            expect(capturedUrl).toContain('api.anthropic.com');
            expect(output.provider).toBe('anthropic');
            expect(output.analysis).toBe('pinned response');
        });

        it('falls through to the next provider when the first returns an empty analysis', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            process.env['ANTHROPIC_API_KEY'] = 'ant-test';
            const seen: string[] = [];
            const fetchFn: VisionFetchFn = async (request) => {
                seen.push(request.url);
                // OpenAI (first in auto chain) returns empty; anthropic returns text.
                if (request.url.includes('openai.com')) {
                    return { body: JSON.stringify({ choices: [] }) };
                }
                return {
                    body: JSON.stringify({ content: [{ type: 'text', text: 'recovered via fallback' }] }),
                };
            };
            const registration = createLookAtToolRegistration({ fetch: fetchFn });
            const input: LookAtInput = { image_data: TINY_PNG_BASE64, goal: 'describe' };
            const output = await registration.execute(input, executionContext() as never);
            expect(seen.some((url) => url.includes('openai.com'))).toBe(true);
            expect(seen.some((url) => url.includes('anthropic.com'))).toBe(true);
            expect(output.analysis).toBe('recovered via fallback');
        });

        it('surfaces a retryable error when every provider in the chain fails', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            process.env['ANTHROPIC_API_KEY'] = 'ant-test';
            const fetchFn: VisionFetchFn = async () => {
                return { body: JSON.stringify({ choices: [] }) };
            };
            const registration = createLookAtToolRegistration({ fetch: fetchFn });
            const input: LookAtInput = { image_data: TINY_PNG_BASE64, goal: 'describe' };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.retryable).toBe(true);
            expect((caught as ToolExecutionError).error.message).toContain('all vision providers failed');
        });
    });

    // -------------------------------------------------------------------------
    // inspect_image
    // -------------------------------------------------------------------------

    describe('inspect_image', () => {
        it('produces a valid ToolRegistration with the inspect_image identity', () => {
            const registration = createInspectImageToolRegistration();
            expect(registration.name).toBe('inspect_image');
            expect(registration.capabilityClasses).toContain('network');
            expect(registration.outputLimit.maxModelOutputChars).toBeGreaterThan(0);
        });

        it('analyzes a single image via image_data with a focused goal', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const registration = createInspectImageToolRegistration({
                fetch: mockFetchReturning('A 1x1 pixel image.'),
            });
            const input: InspectImageInput = {
                image_data: TINY_PNG_BASE64,
                goal: 'what dimensions is this image',
            };
            const output = await registration.execute(input, executionContext() as never);
            expect(output.kind).toBe('inspect_image');
            expect(output.mimeType).toBe('image/png');
            expect(output.analysis).toContain('1x1');
            expect(output.imagePath).toBe('clipboard/pasted image');
        });

        it('analyzes a single image via file_path', async () => {
            process.env['GEMINI_API_KEY'] = 'gem-test';
            const filePath = join(tmpDir, 'shot.png');
            writeFileSync(filePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
            const registration = createInspectImageToolRegistration({
                fetch: mockFetchReturning('Screenshot of an error dialog.'),
            });
            const input: InspectImageInput = { file_path: filePath, goal: 'what error is shown' };
            const output = await registration.execute(input, executionContext() as never);
            expect(output.analysis).toContain('error dialog');
            expect(output.imagePath).toBe(filePath);
        });

        it('rejects a PDF file_path because inspect_image only accepts images', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const filePath = join(tmpDir, 'doc.pdf');
            writeFileSync(filePath, Buffer.from('%PDF-1.4 fake'));
            const registration = createInspectImageToolRegistration({
                fetch: mockFetchReturning('should not reach'),
            });
            const input: InspectImageInput = { file_path: filePath, goal: 'describe' };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.message).toContain('PNG, JPEG, GIF, and WEBP');
        });

        it('throws the credential-gate error when no vision provider is configured', async () => {
            const registration = createInspectImageToolRegistration();
            const input: InspectImageInput = { image_data: TINY_PNG_BASE64, goal: 'describe' };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.message).toContain('No vision provider credential');
        });

        it('enforces the image-size cap on image_data', async () => {
            process.env['OPENAI_API_KEY'] = 'sk-test';
            const oversized = Buffer.alloc(2048, 0x00).toString('base64');
            const registration = createInspectImageToolRegistration({
                maxImageBytes: 64,
                fetch: mockFetchReturning('should not reach'),
            });
            const input: InspectImageInput = { image_data: oversized, goal: 'describe' };
            const caught = await captureError(() => registration.execute(input, executionContext() as never));
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.message).toContain('image-size cap');
        });
    });

    // -------------------------------------------------------------------------
    // model output formatting + registration round-trip
    // -------------------------------------------------------------------------

    describe('toModelOutput + registry', () => {
        it('formats look_at output with a header and the analysis body', () => {
            const registration = createLookAtToolRegistration();
            const output: LookAtOutput = {
                kind: 'look_at',
                provider: 'auto',
                goal: 'describe',
                sourceDescription: 'clipboard/pasted image',
                analysis: 'A red dot.',
                truncated: false,
                originalLength: 11,
                returnedLength: 11,
            };
            const text = registration.toModelOutput?.(output) ?? '';
            expect(text).toContain('look_at analysis');
            expect(text).toContain('A red dot.');
        });

        it('registers both tools into a registry under their names', async () => {
            const registry = new ToolRegistry();
            await import('./look-at-tool').then((module) => module.registerLookAtTool(registry));
            await import('./inspect-image-tool').then((module) => module.registerInspectImageTool(registry));
            const names = registry.advertise().map((tool) => tool.name);
            expect(names).toContain('look_at');
            expect(names).toContain('inspect_image');
        });

        it('defaultVisionFetch surfaces a retryable error on a non-2xx response', async () => {
            globalThis.fetch = (() =>
                Promise.resolve(new Response('boom', { status: 503 }))) as typeof globalThis.fetch;
            const caught = await captureError(() =>
                defaultVisionFetch(
                    { url: 'https://example.test', method: 'POST', headers: {}, body: '' },
                    new AbortController().signal,
                ),
            );
            expect(caught).toBeInstanceOf(ToolExecutionError);
            expect((caught as ToolExecutionError).error.retryable).toBe(true);
            expect((caught as ToolExecutionError).error.message).toContain('HTTP 503');
        });

        it('mockFetchReturningEmpty yields an empty parse so fallback logic is exercisable', async () => {
            const fetchFn = mockFetchReturningEmpty();
            const result = await fetchFn(
                { url: 'https://example.test', method: 'POST', headers: {}, body: '' },
                new AbortController().signal,
            );
            expect(result.body).toContain('"choices":[]');
        });
    });

    async function captureError(thunk: () => unknown | Promise<unknown>): Promise<unknown> {
        try {
            await thunk();
        } catch (error: unknown) {
            return error;
        }
        throw new Error('expected execute to throw');
    }
});
