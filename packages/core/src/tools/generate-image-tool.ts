/**
 * `generate_image` tool registration (checkbox #33 — port-ref-tools).
 *
 * Credential-gated seam ported from oh-my-pi `image-gen.ts` (MIT). The seam
 * owns: schema surface (protocol), credential gating at registration time, an
 * injectable transport (so tests mock the provider), and artifact-dir output.
 *
 * Media is NEVER inlined: the transport returns raw bytes that this tool
 * writes to the artifacts dir; the serialized output carries paths only.
 */
import {
    type GenerateImageInput,
    type GenerateImageOutput,
    generateImageInputSchema,
    generateImageOutputSchema,
    MEDIA_IMAGE_PROVIDER_IDS,
    MEDIA_IMAGE_PROVIDER_PREFERENCE,
    type MediaImageProviderId,
    type MediaImageProviderPreference,
} from '@mission-control/protocol';
import type { z } from 'zod';
import { resolveMissionControlDataDir } from '../memory/data-dir.js';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MEDIA_ARTIFACTS_SUBDIR = 'artifacts/media';

export type GeneratedImageBytes = {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
};

export type GenerateImageTransportInput = {
    readonly prompt: string;
    readonly aspectRatio?: string;
    readonly imageSize?: string;
    /** Decoded input images for edits (already base64-decoded to bytes). */
    readonly inputImages: readonly GeneratedImageBytes[];
};

export type ResolvedImageCredential = {
    readonly provider: MediaImageProviderId;
    readonly apiKey: string;
    readonly model: string;
};

/**
 * Resolves an image-generation credential. Returns `undefined` when no provider
 * is configured, which the registration gate uses to skip the tool entirely.
 */
export type ImageCredentialResolver = () => Promise<ResolvedImageCredential | undefined>;

export type GenerateImageTransport = {
    readonly generate: (
        input: GenerateImageTransportInput,
        credential: ResolvedImageCredential,
        signal: AbortSignal,
    ) => Promise<readonly GeneratedImageBytes[]>;
};

export type GenerateImageToolOptions = {
    readonly sessionId: string;
    readonly artifactsDir?: string;
    readonly credentialResolver?: ImageCredentialResolver;
    readonly transport?: GenerateImageTransport;
};

const DEFAULT_MODELS: Record<MediaImageProviderId, string> = {
    gemini: 'gemini-3-pro-image-preview',
    openai: 'gpt-image-1',
    xai: 'grok-imagine-image',
};

const generateImageInputSchemaType = generateImageInputSchema as z.ZodType<GenerateImageInput>;
const generateImageOutputSchemaType = generateImageOutputSchema as z.ZodType<GenerateImageOutput>;

/**
 * Default env-var-gated credential resolver. Probes Gemini, OpenAI, then xAI
 * (matching the oh-my-pi auto-detect order). Tests inject a custom resolver.
 */
export function createEnvImageCredentialResolver(
    env: Readonly<Record<string, string | undefined>> = process.env,
): ImageCredentialResolver {
    return async () => {
        const geminiKey = env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY'];
        if (geminiKey !== undefined && geminiKey.length > 0) {
            return { provider: 'gemini', apiKey: geminiKey, model: DEFAULT_MODELS['gemini']! };
        }
        const openaiKey = env['OPENAI_API_KEY'];
        if (openaiKey !== undefined && openaiKey.length > 0) {
            return { provider: 'openai', apiKey: openaiKey, model: DEFAULT_MODELS['openai']! };
        }
        const xaiKey = env['XAI_API_KEY'];
        if (xaiKey !== undefined && xaiKey.length > 0) {
            return { provider: 'xai', apiKey: xaiKey, model: DEFAULT_MODELS['xai']! };
        }
        return undefined;
    };
}

/**
 * Credential-gated registration. Returns `undefined` when no credential is
 * configured, so the caller can skip registering the tool entirely.
 */
export async function registerGenerateImageTool(
    registry: ToolRegistry,
    options: GenerateImageToolOptions,
): Promise<ToolAdvertisement | undefined> {
    const resolver = options.credentialResolver ?? createEnvImageCredentialResolver();
    const credential = await resolver();
    if (credential === undefined) {
        return undefined;
    }
    const registration = createGenerateImageToolRegistration(options);
    return registry.register(registration);
}

export function createGenerateImageToolRegistration(
    options: GenerateImageToolOptions,
): ToolRegistration<GenerateImageInput, GenerateImageOutput> {
    const credentialResolver = options.credentialResolver ?? createEnvImageCredentialResolver();
    return {
        name: 'generate_image',
        description:
            'Generate or edit raster images via Gemini, GPT, or xAI Grok image models. ' +
            'Generated images are saved to the media artifacts directory; the tool returns file paths only.',
        capabilityClasses: ['network', 'write'],
        parametersJsonSchema: generateImageParametersJsonSchema(),
        inputSchema: generateImageInputSchemaType,
        outputSchema: generateImageOutputSchemaType,
        outputLimit: { maxModelOutputChars: 4_000 },
        execute: (input, context) => runGenerateImage(input, options, credentialResolver, context.signal),
        toModelOutput: generateImageModelOutput,
        guideline:
            'Use generate_image to create or edit images. Output paths reference on-disk artifacts; ' +
            'image bytes are never returned inline.',
    };
}

async function runGenerateImage(
    input: GenerateImageInput,
    options: GenerateImageToolOptions,
    credentialResolver: ImageCredentialResolver,
    signal: AbortSignal,
): Promise<GenerateImageOutput> {
    const credential = await resolveCredentialForProvider(input.provider, credentialResolver);
    if (credential === undefined) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: noImageCredentialMessage(),
            retryable: false,
        });
    }

    const transport = options.transport ?? defaultImageTransport;
    const inputImages = await decodeInputImages(input);
    const generated = await transport
        .generate(
            {
                prompt: input.prompt,
                ...(input.aspect_ratio !== undefined ? { aspectRatio: input.aspect_ratio } : {}),
                ...(input.image_size !== undefined ? { imageSize: input.image_size } : {}),
                inputImages,
            },
            credential,
            signal,
        )
        .catch((error: unknown) => {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `generate_image failed: ${error instanceof Error ? error.message : String(error)}`,
                retryable: true,
            });
        });

    if (generated.length === 0) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: 'generate_image returned no image data.',
            retryable: true,
        });
    }

    const artifactsDir = resolveArtifactsDir(options);
    const imagePaths = await writeImagesToArtifacts(generated, artifactsDir);

    return {
        image_paths: imagePaths,
        provider: credential.provider,
        model: credential.model,
        count: imagePaths.length,
    };
}

async function resolveCredentialForProvider(
    preference: MediaImageProviderPreference | undefined,
    resolver: ImageCredentialResolver,
): Promise<ResolvedImageCredential | undefined> {
    const resolved = await resolver();
    if (resolved === undefined) {
        return undefined;
    }
    if (preference === undefined || preference === 'auto') {
        return resolved;
    }
    return resolved.provider === preference ? resolved : undefined;
}

async function decodeInputImages(input: GenerateImageInput): Promise<readonly GeneratedImageBytes[]> {
    const entries = input.input ?? [];
    if (entries.length === 0) {
        return [];
    }
    const decoded: GeneratedImageBytes[] = [];
    for (const entry of entries) {
        if (entry.data !== undefined) {
            decoded.push({ bytes: decodeBase64(entry.data), mimeType: entry.mime_type ?? 'image/png' });
        }
    }
    return decoded;
}

function decodeBase64(value: string): Uint8Array {
    const cleaned = value.startsWith('data:') ? (value.split(',', 2)[1] ?? value) : value;
    const buffer = Buffer.from(cleaned, 'base64');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

async function writeImagesToArtifacts(images: readonly GeneratedImageBytes[], artifactsDir: string): Promise<string[]> {
    await mkdir(artifactsDir, { recursive: true });
    const paths: string[] = [];
    for (const image of images) {
        const ext = extensionForMime(image.mimeType);
        const filename = `mctrl-image-${randomUUID()}.${ext}`;
        const filepath = join(artifactsDir, filename);
        await writeFile(filepath, image.bytes);
        paths.push(filepath);
    }
    return paths;
}

function extensionForMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/png':
            return 'png';
        case 'image/jpeg':
            return 'jpg';
        case 'image/gif':
            return 'gif';
        case 'image/webp':
            return 'webp';
        default:
            return 'png';
    }
}

function resolveArtifactsDir(options: GenerateImageToolOptions): string {
    if (options.artifactsDir !== undefined) {
        return options.artifactsDir;
    }
    return join(resolveMissionControlDataDir(), MEDIA_ARTIFACTS_SUBDIR);
}

function generateImageModelOutput(output: GenerateImageOutput): string {
    const lines = [
        `generate_image: provider=${output.provider} model=${output.model} (${output.count} image${output.count === 1 ? '' : 's'})`,
        ...output.image_paths.map((path) => `  ${path}`),
    ];
    return lines.join('\n');
}

export function noImageCredentialMessage(): string {
    return 'No image generation credential configured. Set one of GEMINI_API_KEY (or GOOGLE_API_KEY), OPENAI_API_KEY, or XAI_API_KEY.';
}

export function generateImageParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Image generation or edit prompt.' },
            provider: {
                type: 'string',
                enum: [...MEDIA_IMAGE_PROVIDER_PREFERENCE],
                description: "'auto' (default) uses the first configured provider; pin to gemini, openai, or xai.",
            },
            aspect_ratio: {
                type: 'string',
                enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
                description: 'Output aspect ratio.',
            },
            image_size: {
                type: 'string',
                enum: ['1024x1024', '1536x1024', '1024x1536'],
                description: 'Output pixel dimensions.',
            },
            input: {
                type: 'array',
                description: 'Reference images for edits. Each entry has path or base64 data plus mime_type.',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        data: { type: 'string', description: 'base64-encoded image bytes' },
                        mime_type: { type: 'string' },
                    },
                },
            },
            output_dir: { type: 'string', description: 'Override the artifacts directory.' },
        },
        required: ['prompt'],
        additionalProperties: false,
    };
}

/**
 * Default transport hits the live provider HTTP endpoints. Tests inject a mock.
 */
const defaultImageTransport: GenerateImageTransport = {
    async generate(input, credential, signal) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (credential.provider === 'gemini') {
            headers['x-goog-api-key'] = credential.apiKey;
        } else {
            headers['Authorization'] = `Bearer ${credential.apiKey}`;
        }
        const body = JSON.stringify({
            prompt: input.prompt,
            ...(input.aspectRatio !== undefined ? { aspect_ratio: input.aspectRatio } : {}),
            ...(input.imageSize !== undefined ? { image_size: input.imageSize } : {}),
        });
        const response = await fetch(defaultImageEndpoint(credential), {
            method: 'POST',
            headers,
            body,
            signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(
                `${credential.provider} image request failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
            );
        }
        const payload = (await response.json()) as { data?: Array<{ b64_json?: string; mime_type?: string }> };
        const entries = payload.data ?? [];
        const images: GeneratedImageBytes[] = [];
        for (const entry of entries) {
            if (entry.b64_json !== undefined) {
                images.push({
                    bytes: decodeBase64(entry.b64_json),
                    mimeType: entry.mime_type ?? 'image/png',
                });
            }
        }
        if (images.length === 0) {
            throw new Error(`${credential.provider} returned no image bytes`);
        }
        return images;
    },
};

function defaultImageEndpoint(credential: ResolvedImageCredential): string {
    switch (credential.provider) {
        case 'gemini':
            return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(credential.model)}:generateContent`;
        case 'openai':
            return 'https://api.openai.com/v1/images/generations';
        case 'xai':
            return 'https://api.x.ai/v1/images/generations';
        default:
            return assertNeverProvider(credential.provider);
    }
}

function assertNeverProvider(provider: never): never {
    throw new Error(`Unexpected image provider: ${String(provider)}`);
}

export { MEDIA_IMAGE_PROVIDER_IDS };
