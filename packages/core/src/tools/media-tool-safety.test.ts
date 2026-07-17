import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerateImageToolRegistration, type GenerateImageTransport } from './generate-image-tool';
import { createInspectImageToolRegistration } from './inspect-image-tool';
import { createLookAtToolRegistration } from './look-at-tool';
import { ToolExecutionError } from './tool-registry';
import { createTtsToolRegistration, type TtsTransport } from './tts-tool';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('media tool workspace and permission boundaries', () => {
    const roots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
        roots.length = 0;
    });

    it('rejects a TTS workspace escape before provider I/O or file output', async () => {
        // Given
        const workspaceRoot = await makeRoot('workspace');
        const outsideRoot = await makeRoot('outside');
        const outputPath = join(outsideRoot, 'escaped.wav');
        let synthesizeCalls = 0;
        const transport: TtsTransport = {
            async synthesize(input) {
                synthesizeCalls += 1;
                return { bytes: new Uint8Array([1, 2, 3]), codec: input.codec };
            },
        };
        const registration = createTtsToolRegistration({
            sessionId: 'media-safety',
            workspaceRoot,
            requestPermission: allowPermission,
            credentialResolver: () => Promise.resolve({ apiKey: 'xai-test', baseURL: 'https://api.x.ai' }),
            transport,
        });

        // When
        const error = await captureError(() =>
            registration.execute(
                { text: 'hello', voice_id: 'eve', language: 'en', output_path: outputPath },
                executionContext('tts', 'tts_escape'),
            ),
        );

        // Then
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect(toolErrorMessage(error)).toContain('workspace_escape');
        expect(synthesizeCalls).toBe(0);
        await expect(access(outputPath)).rejects.toThrow();
    });

    it('denies TTS write permission before provider I/O', async () => {
        // Given
        const workspaceRoot = await makeRoot('workspace');
        let synthesizeCalls = 0;
        const requestedKinds: string[] = [];
        const registration = createTtsToolRegistration({
            sessionId: 'media-safety',
            workspaceRoot,
            requestPermission: (request) => {
                requestedKinds.push(request.permission?.kind ?? 'missing');
                return denyPermission(request);
            },
            credentialResolver: () => Promise.resolve({ apiKey: 'xai-test', baseURL: 'https://api.x.ai' }),
            transport: {
                async synthesize(input) {
                    synthesizeCalls += 1;
                    return { bytes: new Uint8Array([1]), codec: input.codec };
                },
            },
        });

        // When
        const error = await captureError(() =>
            registration.execute(
                { text: 'hello', voice_id: 'eve', language: 'en', output_path: 'audio/clip.wav' },
                executionContext('tts', 'tts_denied'),
            ),
        );

        // Then
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect(requestedKinds).toEqual(['write']);
        expect(synthesizeCalls).toBe(0);
    });

    it('denies generated-image output permission before provider I/O', async () => {
        // Given
        const workspaceRoot = await makeRoot('workspace');
        let generateCalls = 0;
        const transport: GenerateImageTransport = {
            async generate() {
                generateCalls += 1;
                return [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }];
            },
        };
        const registration = createGenerateImageToolRegistration({
            sessionId: 'media-safety',
            workspaceRoot,
            requestPermission: denyPermission,
            credentialResolver: () =>
                Promise.resolve({ provider: 'openai', apiKey: 'openai-test', model: 'gpt-image-1' }),
            transport,
        });

        // When
        const error = await captureError(() =>
            registration.execute({ prompt: 'red cube' }, executionContext('generate_image', 'image_denied')),
        );

        // Then
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect(generateCalls).toBe(0);
    });

    it('rejects a generated-image output directory outside the workspace before provider I/O', async () => {
        // Given
        const workspaceRoot = await makeRoot('workspace');
        const outsideRoot = await makeRoot('outside');
        let generateCalls = 0;
        const registration = createGenerateImageToolRegistration({
            sessionId: 'media-safety',
            workspaceRoot,
            requestPermission: allowPermission,
            credentialResolver: () =>
                Promise.resolve({ provider: 'openai', apiKey: 'openai-test', model: 'gpt-image-1' }),
            transport: {
                async generate() {
                    generateCalls += 1;
                    return [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }];
                },
            },
        });

        // When
        const error = await captureError(() =>
            registration.execute(
                { prompt: 'red cube', output_dir: outsideRoot },
                executionContext('generate_image', 'image_escape'),
            ),
        );

        // Then
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect(toolErrorMessage(error)).toContain('workspace_escape');
        expect(generateCalls).toBe(0);
    });

    it('rejects generated-image reference paths outside the workspace before provider I/O', async () => {
        // Given
        const workspaceRoot = await makeRoot('workspace');
        const outsideRoot = await makeRoot('outside');
        const outsideImage = join(outsideRoot, 'outside.png');
        await writeFile(outsideImage, Buffer.from(TINY_PNG_BASE64, 'base64'));
        let generateCalls = 0;
        const registration = createGenerateImageToolRegistration({
            sessionId: 'media-safety',
            workspaceRoot,
            requestPermission: allowPermission,
            credentialResolver: () =>
                Promise.resolve({ provider: 'openai', apiKey: 'openai-test', model: 'gpt-image-1' }),
            transport: {
                async generate() {
                    generateCalls += 1;
                    return [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }];
                },
            },
        });

        // When
        const error = await captureError(() =>
            registration.execute(
                { prompt: 'edit this', input: [{ path: outsideImage }] },
                executionContext('generate_image', 'image_input_escape'),
            ),
        );

        // Then
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect(toolErrorMessage(error)).toContain('workspace_escape');
        expect(generateCalls).toBe(0);
    });

    it('rejects look_at paths outside the workspace before provider I/O', async () => {
        // Given
        vi.stubEnv('OPENAI_API_KEY', 'openai-test');
        const workspaceRoot = await makeRoot('workspace');
        const outsideRoot = await makeRoot('outside');
        const outsideImage = join(outsideRoot, 'outside.png');
        await writeFile(outsideImage, Buffer.from(TINY_PNG_BASE64, 'base64'));
        let fetchCalls = 0;
        const registration = createLookAtToolRegistration({
            workspaceRoot,
            requestPermission: allowPermission,
            fetch: async () => {
                fetchCalls += 1;
                return { body: JSON.stringify({ choices: [{ message: { content: 'unsafe' } }] }) };
            },
        });

        // When
        const error = await captureError(() =>
            registration.execute(
                { file_path: outsideImage, goal: 'describe' },
                executionContext('look_at', 'look_escape'),
            ),
        );

        // Then
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect(toolErrorMessage(error)).toContain('workspace_escape');
        expect(fetchCalls).toBe(0);
    });

    it('denies inspect_image network permission before provider I/O', async () => {
        // Given
        vi.stubEnv('OPENAI_API_KEY', 'openai-test');
        const workspaceRoot = await makeRoot('workspace');
        const requestedKinds: string[] = [];
        let fetchCalls = 0;
        const registration = createInspectImageToolRegistration({
            workspaceRoot,
            requestPermission: (request) => {
                requestedKinds.push(request.permission?.kind ?? 'missing');
                return denyPermission(request);
            },
            fetch: async () => {
                fetchCalls += 1;
                return { body: JSON.stringify({ choices: [{ message: { content: 'unsafe' } }] }) };
            },
        });

        // When
        const error = await captureError(() =>
            registration.execute(
                { image_data: TINY_PNG_BASE64, goal: 'describe' },
                executionContext('inspect_image', 'inspect_denied'),
            ),
        );

        // Then
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect(requestedKinds).toEqual(['network']);
        expect(fetchCalls).toBe(0);
    });

    async function makeRoot(label: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), `mctrl-media-${label}-`));
        roots.push(root);
        return root;
    }
});

function executionContext(toolName: string, toolCallId: string) {
    return { toolName, toolCallId, signal: new AbortController().signal };
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function denyPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'deny', reason: 'test deny' };
}

async function captureError(thunk: () => unknown | Promise<unknown>): Promise<unknown> {
    try {
        await thunk();
    } catch (error: unknown) {
        return error;
    }
    throw new Error('expected execute to throw');
}

function toolErrorMessage(error: unknown): string {
    if (!(error instanceof ToolExecutionError)) throw new TypeError('expected ToolExecutionError');
    return error.error.message;
}
