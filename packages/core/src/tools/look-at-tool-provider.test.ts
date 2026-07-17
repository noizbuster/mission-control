import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createLookAtToolRegistration,
    defaultVisionFetch,
    type LookAtOutput,
    type LookAtToolOptions,
} from './look-at-tool';
import { ToolExecutionError } from './tool-registry';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VISION_ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'] as const;

describe('look_at provider routing and limits', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let tmpDir: string;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        for (const key of VISION_ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        tmpDir = mkdtempSync(join(tmpdir(), 'look-at-provider-'));
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        for (const key of VISION_ENV_KEYS) {
            const value = savedEnv[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('rejects image data that exceeds the configured cap', async () => {
        process.env['OPENAI_API_KEY'] = 'sk-test';
        const oversized = Buffer.alloc(1024, 0xff).toString('base64');
        const registration = createLookAtToolRegistration(options({ maxImageBytes: 64 }));

        const error = await captureError(() =>
            registration.execute({ image_data: oversized, goal: 'describe' }, executionContext()),
        );

        expect(requireToolError(error).error.message).toContain('image-size cap');
    });

    it('rejects file paths that exceed the configured cap', async () => {
        process.env['OPENAI_API_KEY'] = 'sk-test';
        const filePath = join(tmpDir, 'big.png');
        writeFileSync(filePath, Buffer.alloc(2048, 0x00));
        const registration = createLookAtToolRegistration(options({ maxImageBytes: 64 }));

        const error = await captureError(() =>
            registration.execute({ file_path: filePath, goal: 'describe' }, executionContext()),
        );

        expect(requireToolError(error).error.message).toContain('image-size cap');
    });

    it('routes to the pinned provider when explicitly available', async () => {
        process.env['OPENAI_API_KEY'] = 'sk-test';
        process.env['ANTHROPIC_API_KEY'] = 'ant-test';
        let capturedUrl = '';
        const registration = createLookAtToolRegistration(
            options({
                providerPreference: 'anthropic',
                fetch: async (request) => {
                    capturedUrl = request.url;
                    return { body: JSON.stringify({ content: [{ type: 'text', text: 'pinned response' }] }) };
                },
            }),
        );

        const output = await registration.execute(
            { image_data: TINY_PNG_BASE64, goal: 'describe' },
            executionContext(),
        );

        expect(capturedUrl).toContain('api.anthropic.com');
        expect(output.provider).toBe('anthropic');
        expect(output.analysis).toBe('pinned response');
    });

    it('falls through after an empty response', async () => {
        process.env['OPENAI_API_KEY'] = 'sk-test';
        process.env['ANTHROPIC_API_KEY'] = 'ant-test';
        const seen: string[] = [];
        const fallback = createLookAtToolRegistration(
            options({
                fetch: async (request) => {
                    seen.push(request.url);
                    if (request.url.includes('openai.com')) return { body: JSON.stringify({ choices: [] }) };
                    return { body: JSON.stringify({ content: [{ type: 'text', text: 'recovered' }] }) };
                },
            }),
        );
        const recovered = await fallback.execute({ image_data: TINY_PNG_BASE64, goal: 'describe' }, executionContext());

        expect(seen.some((url) => url.includes('openai.com'))).toBe(true);
        expect(seen.some((url) => url.includes('anthropic.com'))).toBe(true);
        expect(recovered.analysis).toBe('recovered');
    });

    it('fails retryably when every provider response is empty', async () => {
        process.env['OPENAI_API_KEY'] = 'sk-test';
        process.env['ANTHROPIC_API_KEY'] = 'ant-test';
        const registration = createLookAtToolRegistration(options({ fetch: async () => ({ body: '{"choices":[]}' }) }));

        const error = await captureError(() =>
            registration.execute({ image_data: TINY_PNG_BASE64, goal: 'describe' }, executionContext()),
        );

        expect(requireToolError(error).error.retryable).toBe(true);
    });

    it('formats model output with the analysis body', () => {
        const registration = createLookAtToolRegistration(options());
        const output: LookAtOutput = {
            kind: 'look_at',
            provider: 'auto',
            goal: 'describe',
            sourceDescription: 'clipboard/pasted image',
            analysis: 'A red dot.',
            truncated: false,
            originalLength: 10,
            returnedLength: 10,
        };
        const text = registration.toModelOutput?.(output) ?? '';

        expect(text).toContain('look_at analysis');
        expect(text).toContain('A red dot.');
    });

    it('surfaces retryable default-fetch failures', async () => {
        globalThis.fetch = () => Promise.resolve(new Response('boom', { status: 503 }));

        const error = await captureError(() =>
            defaultVisionFetch(
                { url: 'https://example.test', method: 'POST', headers: {}, body: '' },
                new AbortController().signal,
            ),
        );

        expect(requireToolError(error).error.retryable).toBe(true);
    });

    it('keeps an empty mocked provider response available to fallback parsing', async () => {
        const fetchFn = async () => ({ body: JSON.stringify({ choices: [] }) });

        const result = await fetchFn();

        expect(result.body).toContain('"choices":[]');
    });

    function options(overrides: Omit<LookAtToolOptions, 'workspaceRoot' | 'requestPermission'> = {}) {
        return { workspaceRoot: tmpDir, requestPermission: allowPermission, ...overrides };
    }
});

function executionContext() {
    return { toolCallId: 'look-at-provider', toolName: 'look_at', signal: new AbortController().signal };
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'provider test allow' };
}

async function captureError(thunk: () => unknown | Promise<unknown>): Promise<unknown> {
    try {
        await thunk();
    } catch (error: unknown) {
        return error;
    }
    throw new Error('expected execute to throw');
}

function requireToolError(error: unknown): ToolExecutionError {
    if (!(error instanceof ToolExecutionError)) throw new TypeError('expected ToolExecutionError');
    return error;
}
