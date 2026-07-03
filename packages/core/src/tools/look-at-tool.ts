/**
 * `look_at` tool (Task 32, port-ref-tools checkbox #32): analyze images, PDFs,
 * and diagrams via a vision-capable LLM provider.
 *
 * Clean-room port of the oh-my-openagent `look_at` surface (reference rewritten
 * to mission-control's ToolRegistration contract). The reference delegates to a
 * `multimodal-looker` subagent; this port calls a vision-capable provider directly through {@link resolveVisionProviderChain}, mirroring the
 * web-search credential-gate pattern. No subagent spawn, no image-format
 * conversion shell-outs (HEIC/RAW/PSD conversion via `sips`/ImageMagick is
 * out of scope for this scaffold port).
 *
 * Accepts one or more of: `file_path`, `file_paths`, `image_data`,
 * `image_data_list`. Files are read locally; remote URLs are rejected. Each
 * image/document is base64-encoded and capped at {@link DEFAULT_MAX_IMAGE_BYTES}
 * before it is sent. Class `['network']`, exec tier, outputLimit on model output.
 *
 * Credential gate: when no vision provider credential is configured the tool
 * throws a non-retryable `ToolExecutionError` naming the env vars that would
 * unlock it, so the model never sends an image to a provider without consent.
 */

import type { ProtocolError } from '@mission-control/protocol';
import { z } from 'zod';
import { redactCredentialText } from '../providers/credential-resolver.js';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { truncateOutput } from './truncate.js';
import {
    collectVisionSecrets,
    resolveVisionProviderChain,
    type VisionHttpRequest,
    type VisionImage,
    type VisionProvider,
} from './vision-providers.js';
import { type VisionProviderId, visionCredentialHint } from './vision-schemas.js';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOOK_AT_TOOL_NAME = 'look_at';
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB per image, matches typical provider limits
const DEFAULT_MAX_MODEL_OUTPUT_CHARS = 10_000;
const VISION_TIMEOUT_MS = 60_000;

const LOOK_AT_DESCRIPTION =
    'Extract basic information from media files (PDFs, images, diagrams) when a quick summary suffices over ' +
    'precise reading. Good for simple text-based content extraction without using the Read tool. NEVER use for ' +
    'visual precision, aesthetic evaluation, or exact accuracy — use the Read tool instead for those cases.';

const LOOK_AT_GUIDELINE =
    'Use look_at for a quick summary of an image, PDF, or diagram. Pass a focused goal describing what to extract. ' +
    'Requires a configured vision provider credential (OPENAI/ANTHROPIC/GEMINI/OPENROUTER/ZAI). Results are a ' +
    'summary, not a precise read — use the Read tool when exact text matters.';

// ---------------------------------------------------------------------------
// Input / output schemas
// ---------------------------------------------------------------------------

export const lookAtInputSchema = z
    .object({
        file_path: z.string().min(1).optional(),
        file_paths: z.array(z.string().min(1)).optional(),
        image_data: z.string().min(1).optional(),
        image_data_list: z.array(z.string().min(1)).optional(),
        goal: z.string().min(1),
    })
    .strict();
export type LookAtInput = z.infer<typeof lookAtInputSchema>;

export const lookAtOutputSchema = z
    .object({
        kind: z.literal('look_at'),
        provider: z.string(),
        goal: z.string(),
        sourceDescription: z.string(),
        analysis: z.string(),
        truncated: z.boolean(),
        originalLength: z.number().int().nonnegative(),
        returnedLength: z.number().int().nonnegative(),
    })
    .strict();
export type LookAtOutput = z.infer<typeof lookAtOutputSchema>;

// ---------------------------------------------------------------------------
// MIME inference (clean-room; file signatures are factual, not licensed expression)
// ---------------------------------------------------------------------------

const EXTENSION_MIME_MAP: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.json': 'application/json',
};

export function inferMimeTypeFromFilePath(filePath: string): string {
    return EXTENSION_MIME_MAP[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function inferMimeTypeFromBase64(base64Data: string): string {
    if (base64Data.startsWith('data:')) {
        const match = /^data:([^;]+);/.exec(base64Data);
        if (match !== null && match[1] !== undefined) return match[1];
    }
    try {
        const cleanData = stripDataUriPrefix(base64Data);
        const header = Buffer.from(cleanData.slice(0, 256), 'base64').toString('binary');
        if (header.startsWith('\x89PNG')) return 'image/png';
        if (header.startsWith('\xFF\xD8\xFF')) return 'image/jpeg';
        if (header.startsWith('GIF8')) return 'image/gif';
        if (header.startsWith('RIFF') && header.includes('WEBP')) return 'image/webp';
        if (header.startsWith('%PDF')) return 'application/pdf';
    } catch {
        // Fall through to default when header decode fails (e.g. malformed base64).
    }
    return 'image/png';
}

export function stripDataUriPrefix(imageData: string): string {
    if (imageData.startsWith('data:')) {
        const commaIndex = imageData.indexOf(',');
        if (commaIndex !== -1) {
            return imageData.slice(commaIndex + 1);
        }
    }
    return imageData;
}

// ---------------------------------------------------------------------------
// Input preparation
// ---------------------------------------------------------------------------

export type PreparedVisionInput = {
    readonly images: readonly VisionImage[];
    readonly sourceDescription: string;
};

export type PrepareVisionResult =
    | { readonly ok: true; readonly value: PreparedVisionInput }
    | { readonly ok: false; readonly error: string };

function isRemoteUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

function assertImageSize(bytes: Buffer, maxImageBytes: number, label: string): void {
    if (bytes.byteLength > maxImageBytes) {
        throw lookAtFailure(
            `${label} is ${bytes.byteLength} bytes which exceeds the ${maxImageBytes}-byte image-size cap. ` +
                'Downscale the image before sending.',
            false,
        );
    }
}

function readFileAsVisionImage(filePath: string, maxImageBytes: number): VisionImage {
    let stats: { size: number };
    try {
        stats = statSync(filePath);
    } catch (error: unknown) {
        const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
        if (code === 'ENOENT') {
            throw lookAtFailure(`File not found: ${filePath}`, false);
        }
        throw lookAtFailure(`Failed to stat ${filePath}: ${errorMessage(error)}`, false);
    }
    let bytes: Buffer;
    try {
        bytes = readFileSync(filePath);
    } catch (error: unknown) {
        const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
        if (code === 'ENOENT') {
            throw lookAtFailure(`File not found: ${filePath}`, false);
        }
        throw lookAtFailure(`Failed to read ${filePath}: ${errorMessage(error)}`, false);
    }
    assertImageSize(bytes, maxImageBytes, filePath);
    const mimeType = inferMimeTypeFromFilePath(filePath);
    return { mimeType, base64Data: bytes.toString('base64'), filename: basename(filePath) };
}

function readBase64AsVisionImage(imageData: string, maxImageBytes: number, index: number): VisionImage {
    const cleanData = stripDataUriPrefix(imageData);
    const decoded = Buffer.from(cleanData, 'base64');
    assertImageSize(decoded, maxImageBytes, `image_data[${index}]`);
    const mimeType = inferMimeTypeFromBase64(imageData);
    const ext = mimeType.split('/')[1] ?? 'png';
    return { mimeType, base64Data: cleanData, filename: `clipboard-image-${index}.${ext}` };
}

export function prepareLookAtInput(input: LookAtInput, maxImageBytes: number): PrepareVisionResult {
    const filePaths = input.file_paths ?? (input.file_path !== undefined ? [input.file_path] : []);
    const imageDataList = input.image_data_list ?? (input.image_data !== undefined ? [input.image_data] : []);
    const totalInputs = filePaths.length + imageDataList.length;

    if (totalInputs === 0) {
        return {
            ok: false,
            error: "Must provide either 'file_path', 'file_paths', 'image_data', or 'image_data_list'.",
        };
    }

    for (const filePath of filePaths) {
        if (isRemoteUrl(filePath)) {
            return {
                ok: false,
                error: `Remote URLs are not supported for file paths. Download the file first or use a local path: ${filePath}`,
            };
        }
    }

    const images: VisionImage[] = [];
    for (const filePath of filePaths) {
        try {
            images.push(readFileAsVisionImage(filePath, maxImageBytes));
        } catch (error: unknown) {
            if (error instanceof ToolExecutionError) return { ok: false, error: error.error.message };
            return { ok: false, error: errorMessage(error) };
        }
    }
    for (let index = 0; index < imageDataList.length; index += 1) {
        try {
            images.push(readBase64AsVisionImage(imageDataList[index] as string, maxImageBytes, index));
        } catch (error: unknown) {
            if (error instanceof ToolExecutionError) return { ok: false, error: error.error.message };
            return { ok: false, error: errorMessage(error) };
        }
    }

    const sourceDescription =
        totalInputs > 1
            ? `${totalInputs} files/images`
            : imageDataList.length === 1
              ? 'clipboard/pasted image'
              : (filePaths[0] ?? 'image');
    return { ok: true, value: { images, sourceDescription } };
}

// ---------------------------------------------------------------------------
// Vision transport
// ---------------------------------------------------------------------------

/** Injectable fetch seam so tests drive the chain without real network calls. */
export type VisionFetchFn = (request: VisionHttpRequest, signal: AbortSignal) => Promise<{ readonly body: string }>;

export const defaultVisionFetch: VisionFetchFn = async (request, signal) => {
    const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw lookAtFailure(
            `vision provider returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`,
            true,
        );
    }
    return { body: await response.text() };
};

async function runVisionAnalysis(
    images: readonly VisionImage[],
    goal: string,
    preference: VisionProviderId | 'auto',
    fetchFn: VisionFetchFn,
    signal: AbortSignal,
): Promise<string> {
    const chain = resolveVisionProviderChain(preference);
    if (chain.length === 0) {
        throw lookAtFailure(
            `No vision provider credential is configured. Set one of: ${visionCredentialHint()}.`,
            false,
        );
    }
    const secrets = collectVisionSecrets();
    const requestInput: { readonly goal: string; readonly images: readonly VisionImage[] } = { goal, images };

    let lastError: Error | undefined;
    for (const provider of chain) {
        try {
            const request = provider.buildRequest(requestInput);
            const response = await fetchFn(request, signal);
            const analysis = provider.parseResponse(response.body);
            if (analysis.length === 0) {
                throw lookAtFailure(`${provider.label} returned an empty analysis`, true);
            }
            return redactCredentialText(analysis, secrets);
        } catch (error: unknown) {
            if (error instanceof ToolExecutionError && !error.error.retryable) {
                throw error;
            }
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }
    throw lookAtFailure(`all vision providers failed${lastError !== undefined ? `: ${lastError.message}` : ''}`, true);
}

// ---------------------------------------------------------------------------
// Tool options + registration
// ---------------------------------------------------------------------------

export type LookAtToolOptions = {
    readonly providerPreference?: VisionProviderId | 'auto';
    readonly maxImageBytes?: number;
    readonly maxModelOutputChars?: number;
    readonly fetch?: VisionFetchFn;
    readonly timeoutMs?: number;
};

type ResolvedLookAtToolOptions = {
    readonly providerPreference: VisionProviderId | 'auto';
    readonly maxImageBytes: number;
    readonly maxModelOutputChars: number;
    readonly fetch: VisionFetchFn;
    readonly timeoutMs: number;
};

export async function registerLookAtTool(
    registry: ToolRegistry,
    options: LookAtToolOptions = {},
): Promise<ToolAdvertisement> {
    return registry.register(createLookAtToolRegistration(options));
}

export function createLookAtToolRegistration(
    options: LookAtToolOptions = {},
): ToolRegistration<LookAtInput, LookAtOutput> {
    const resolved = resolveLookAtOptions(options);
    return {
        name: LOOK_AT_TOOL_NAME,
        description: LOOK_AT_DESCRIPTION,
        capabilityClasses: ['network'],
        parametersJsonSchema: lookAtParametersJsonSchema(),
        // exactOptionalPropertyTypes: Zod infers `| undefined` on optional fields; the hand-written
        // input type omits it. Cast at the registration boundary, same pattern as the browser tool.
        inputSchema: lookAtInputSchema as z.ZodType<LookAtInput>,
        outputSchema: lookAtOutputSchema as z.ZodType<LookAtOutput>,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runLookAt(resolved, input, context),
        toModelOutput: lookAtModelOutput,
        guideline: LOOK_AT_GUIDELINE,
    };
}

function resolveLookAtOptions(options: LookAtToolOptions): ResolvedLookAtToolOptions {
    return {
        providerPreference: options.providerPreference ?? 'auto',
        maxImageBytes: options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
        maxModelOutputChars: options.maxModelOutputChars ?? DEFAULT_MAX_MODEL_OUTPUT_CHARS,
        fetch: options.fetch ?? defaultVisionFetch,
        timeoutMs: options.timeoutMs ?? VISION_TIMEOUT_MS,
    };
}

function lookAtParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the file to analyze.' },
            file_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths to multiple files to analyze together.',
            },
            image_data: {
                type: 'string',
                description: 'Base64-encoded image data (for clipboard/pasted images). May include a data: prefix.',
            },
            image_data_list: {
                type: 'array',
                items: { type: 'string' },
                description: 'Base64-encoded image data entries (for multiple clipboard/pasted images).',
            },
            goal: { type: 'string', description: 'What specific information to extract from the file(s).' },
        },
        required: ['goal'],
        additionalProperties: false,
    };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function runLookAt(
    options: ResolvedLookAtToolOptions,
    input: LookAtInput,
    context: ToolExecutionContext,
): Promise<LookAtOutput> {
    const prepared = prepareLookAtInput(input, options.maxImageBytes);
    if (!prepared.ok) {
        throw lookAtFailure(prepared.error, false);
    }
    const { images, sourceDescription } = prepared.value;

    const controller = wireAbort(context.signal);
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs);

    let analysis: string;
    try {
        analysis = await runVisionAnalysis(
            images,
            input.goal,
            options.providerPreference,
            options.fetch,
            controller.signal,
        );
    } catch (error: unknown) {
        if (timedOut && error instanceof Error && error.name === 'AbortError') {
            throw lookAtFailure(`look_at timed out after ${options.timeoutMs}ms`, true);
        }
        throw error;
    } finally {
        clearTimeout(timeoutHandle);
    }

    const limited = truncateOutput(analysis, options.maxModelOutputChars);
    return {
        kind: 'look_at',
        provider: options.providerPreference === 'auto' ? 'auto' : options.providerPreference,
        goal: input.goal,
        sourceDescription,
        analysis: limited.content,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
        returnedLength: limited.content.length,
    };
}

function lookAtModelOutput(output: LookAtOutput): string {
    const lines: string[] = [`## look_at analysis (${output.sourceDescription})`];
    if (output.truncated) {
        lines.push('[output truncated]');
    }
    lines.push('', output.analysis);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared helpers (reused by inspect_image)
// ---------------------------------------------------------------------------

function wireAbort(signal: AbortSignal): AbortController {
    const controller = new AbortController();
    if (signal.aborted) {
        controller.abort();
    } else {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return controller;
}

export function lookAtFailure(message: string, retryable: boolean): ToolExecutionError {
    const error: ProtocolError = { code: 'tool_failed', message, retryable };
    return new ToolExecutionError(error);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Re-export for inspect_image and tests. */
export {
    DEFAULT_MAX_IMAGE_BYTES as LOOK_AT_DEFAULT_MAX_IMAGE_BYTES,
    resolveVisionProviderChain as resolveLookAtVisionChain,
    runVisionAnalysis,
    type VisionImage,
    type VisionProvider,
};
