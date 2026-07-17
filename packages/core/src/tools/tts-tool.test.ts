import type { PermissionDecision, PermissionRequest, TtsInput } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolExecutionError, ToolRegistry } from './tool-registry';
import { createTtsToolRegistration, registerTtsTool, type TtsToolOptions, type TtsTransport } from './tts-tool';
import { randomUUID } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('tts media seam', () => {
    let artifactsDir: string;

    beforeEach(() => {
        artifactsDir = join(tmpdir(), `mctrl-tts-test-${randomUUID()}`);
    });

    afterEach(async () => {
        await rm(artifactsDir, { recursive: true, force: true });
    });

    it('registers only when an xAI credential is configured', async () => {
        const configured = new ToolRegistry();
        const missing = new ToolRegistry();

        const advertisement = await registerTtsTool(configured, ttsOptions());
        const absent = await registerTtsTool(
            missing,
            ttsOptions({ credentialResolver: () => Promise.resolve(undefined) }),
        );

        expect(advertisement?.name).toBe('tts');
        expect(absent).toBeUndefined();
        expect(missing.advertise().find((tool) => tool.name === 'tts')).toBeUndefined();
    });

    it('writes audio bytes to output_path and returns the path only', async () => {
        const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
        const registration = createTtsToolRegistration(ttsOptions({ transport: mockTransport(audioBytes) }));
        const outputPath = join(artifactsDir, 'clip.wav');
        const input: TtsInput = {
            text: 'hello world',
            voice_id: 'eve',
            language: 'en',
            output_path: outputPath,
        };

        const output = await registration.execute(input, executionContext());

        expect(output.audio_path).toBe(outputPath);
        expect(output.bytes).toBe(audioBytes.byteLength);
        expect(output.codec).toBe('wav');
        expect(output.backend).toBe('xai');
        expect(Array.from(await readFile(outputPath))).toEqual(Array.from(audioBytes));
    });

    it('keeps audio bytes out of serialized output', async () => {
        const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xaa, 0xbb]);
        const registration = createTtsToolRegistration(ttsOptions({ transport: mockTransport(audioBytes) }));

        const output = await registration.execute(
            {
                text: 'no inline media',
                voice_id: 'rex',
                language: 'en',
                output_path: join(artifactsDir, 'clip2.wav'),
            },
            executionContext(),
        );

        const serialized = JSON.stringify(output);
        expect(serialized).not.toContain(Buffer.from(audioBytes).toString('base64'));
        expect(serialized).not.toMatch(/data:audio/);
    });

    it('fails non-retryably when the execute-time credential is absent', async () => {
        const registration = createTtsToolRegistration(
            ttsOptions({ credentialResolver: () => Promise.resolve(undefined) }),
        );

        const caught = await captureError(() =>
            registration.execute(
                { text: 'hi', voice_id: 'eve', language: 'en', output_path: join(artifactsDir, 'x.wav') },
                executionContext(),
            ),
        );

        const error = requireToolError(caught);
        expect(error.error.retryable).toBe(false);
        expect(error.error.message).toContain('XAI_API_KEY');
    });

    it('creates missing output parent directories', async () => {
        const registration = createTtsToolRegistration(
            ttsOptions({ transport: mockTransport(new Uint8Array([1, 2, 3])) }),
        );
        const nestedOutput = join(artifactsDir, 'nested', 'deep', 'clip.mp3');

        await registration.execute(
            { text: 'nested', voice_id: 'leo', language: 'en', output_path: nestedOutput },
            executionContext(),
        );

        await expect(access(nestedOutput)).resolves.toBeUndefined();
    });

    function ttsOptions(overrides: Partial<TtsToolOptions> = {}): TtsToolOptions {
        return {
            sessionId: 'session-test',
            workspaceRoot: tmpdir(),
            requestPermission: allowPermission,
            credentialResolver: () => Promise.resolve({ apiKey: 'xai-key', baseURL: 'https://api.x.ai' }),
            ...overrides,
        };
    }
});

function mockTransport(bytes: Uint8Array): TtsTransport {
    return {
        async synthesize(input) {
            expect(input.text.length).toBeGreaterThan(0);
            return { bytes, codec: input.codec };
        },
    };
}

function executionContext() {
    return { toolCallId: 'tts-call', toolName: 'tts', signal: new AbortController().signal };
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'tts test allow' };
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
