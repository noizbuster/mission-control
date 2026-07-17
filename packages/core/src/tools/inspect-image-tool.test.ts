import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createInspectImageToolRegistration,
    type InspectImageInput,
    type InspectImageToolOptions,
    registerInspectImageTool,
} from './inspect-image-tool';
import { registerLookAtTool, type VisionFetchFn } from './look-at-tool';
import { ToolExecutionError, ToolRegistry } from './tool-registry';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VISION_ENV_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY'] as const;

describe('inspect_image tool', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let tmpDir: string;

    beforeEach(() => {
        for (const key of VISION_ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        tmpDir = mkdtempSync(join(tmpdir(), 'inspect-image-'));
    });

    afterEach(() => {
        for (const key of VISION_ENV_KEYS) {
            const value = savedEnv[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('registers with the inspect_image identity', () => {
        const registration = createInspectImageToolRegistration(options());

        expect(registration.name).toBe('inspect_image');
        expect(registration.capabilityClasses).toContain('network');
    });

    it('registers alongside look_at', async () => {
        const registry = new ToolRegistry();

        await registerLookAtTool(registry, options());
        await registerInspectImageTool(registry, options());

        expect(registry.advertise().map((tool) => tool.name)).toEqual(['look_at', 'inspect_image']);
    });

    it('analyzes image_data with a focused goal', async () => {
        process.env['OPENAI_API_KEY'] = 'sk-test';
        const registration = createInspectImageToolRegistration(
            options({ fetch: mockFetchReturning('A 1x1 pixel image.') }),
        );
        const input: InspectImageInput = {
            image_data: TINY_PNG_BASE64,
            goal: 'what dimensions is this image',
        };

        const output = await registration.execute(input, executionContext());

        expect(output.kind).toBe('inspect_image');
        expect(output.mimeType).toBe('image/png');
        expect(output.analysis).toContain('1x1');
        expect(output.imagePath).toBe('clipboard/pasted image');
    });

    it('analyzes an in-workspace image file', async () => {
        process.env['GEMINI_API_KEY'] = 'gem-test';
        const filePath = join(tmpDir, 'shot.png');
        writeFileSync(filePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
        const registration = createInspectImageToolRegistration(
            options({ fetch: mockFetchReturning('Screenshot of an error dialog.') }),
        );

        const output = await registration.execute(
            { file_path: filePath, goal: 'what error is shown' },
            executionContext(),
        );

        expect(output.analysis).toContain('error dialog');
        expect(output.imagePath).toBe(filePath);
    });

    it('rejects PDF file paths', async () => {
        process.env['OPENAI_API_KEY'] = 'sk-test';
        const filePath = join(tmpDir, 'doc.pdf');
        writeFileSync(filePath, Buffer.from('%PDF-1.4 fake'));
        const registration = createInspectImageToolRegistration(options());

        const error = await captureError(() =>
            registration.execute({ file_path: filePath, goal: 'describe' }, executionContext()),
        );

        expect(requireToolError(error).error.message).toContain('PNG, JPEG, GIF, and WEBP');
    });

    it('rejects oversized image data', async () => {
        process.env['OPENAI_API_KEY'] = 'sk-test';
        const registration = createInspectImageToolRegistration(options({ maxImageBytes: 64 }));

        const error = await captureError(() =>
            registration.execute(
                { image_data: Buffer.alloc(2048).toString('base64'), goal: 'describe' },
                executionContext(),
            ),
        );

        expect(requireToolError(error).error.message).toContain('image-size cap');
    });

    it('keeps the execute-time credential gate', async () => {
        const registration = createInspectImageToolRegistration(options());

        const error = await captureError(() =>
            registration.execute({ image_data: TINY_PNG_BASE64, goal: 'describe' }, executionContext()),
        );

        expect(requireToolError(error).error.message).toContain('No vision provider credential');
    });

    function options(overrides: Omit<InspectImageToolOptions, 'workspaceRoot' | 'requestPermission'> = {}) {
        return { workspaceRoot: tmpDir, requestPermission: allowPermission, ...overrides };
    }
});

function mockFetchReturning(analysis: string): VisionFetchFn {
    return async (request) => {
        if (request.url.includes('generativelanguage.googleapis.com')) {
            return { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: analysis }] } }] }) };
        }
        return { body: JSON.stringify({ choices: [{ message: { content: analysis } }] }) };
    };
}

function executionContext() {
    return { toolCallId: 'inspect-image', toolName: 'inspect_image', signal: new AbortController().signal };
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'inspect test allow' };
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
