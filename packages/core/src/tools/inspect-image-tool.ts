/**
 * `inspect_image` tool (Task 32, port-ref-tools checkbox #32): single-image
 * vision analysis via a vision-capable LLM provider.
 *
 * Port of oh-my-pi's `inspect_image` surface (MIT, Can Boluk / Mario Zechner),
 * rewritten to mission-control's ToolRegistration contract and stripped of the
 * attachment-reference resolution, model-role registry, telemetry, and
 * settings-gate machinery that belong to oh-my-pi's richer runtime. It reuses
 * the same credential-gated vision provider chain and image-size cap as
 * {@link look_at}, but accepts a single image (`file_path` or `image_data`)
 * plus a focused `goal`/question.
 *
 * Class `['network']`, exec tier, outputLimit on model output, image-size cap
 * before send. Credential gate is identical to look_at: no vision credential
 * configured → non-retryable `ToolExecutionError` naming the env vars.
 */
import type { ProtocolError } from '@mission-control/protocol';
import { z } from 'zod';
import {
    inferMimeTypeFromBase64,
    inferMimeTypeFromFilePath,
    lookAtFailure,
    runVisionAnalysis,
    stripDataUriPrefix,
    type VisionFetchFn,
    type VisionImage,
} from './look-at-tool.js';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { truncateOutput } from './truncate.js';
import type { VisionProviderId } from './vision-schemas.js';
import { visionCredentialHint } from './vision-schemas.js';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const INSPECT_IMAGE_TOOL_NAME = 'inspect_image';
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_MODEL_OUTPUT_CHARS = 10_000;
const VISION_TIMEOUT_MS = 60_000;

const INSPECT_IMAGE_DESCRIPTION =
    'Describe or analyze a single image file. Accepts an absolute file path or base64-encoded image data plus a ' +
    'focused question. Good for OCR, screenshot debugging, and scene/object questions. Only supports images ' +
    '(PNG, JPEG, GIF, WEBP) detected by file content. Requires a configured vision provider credential.';

const INSPECT_IMAGE_GUIDELINE =
    'Use inspect_image to answer a focused question about one image. For multi-file analysis or PDFs use look_at. ' +
    'Requires a configured vision provider credential (OPENAI/ANTHROPIC/GEMINI/OPENROUTER/ZAI).';

// ---------------------------------------------------------------------------
// Input / output schemas
// ---------------------------------------------------------------------------

export const inspectImageInputSchema = z
    .object({
        file_path: z.string().min(1).optional(),
        image_data: z.string().min(1).optional(),
        goal: z.string().min(1),
    })
    .strict();
export type InspectImageInput = z.infer<typeof inspectImageInputSchema>;

export const inspectImageOutputSchema = z
    .object({
        kind: z.literal('inspect_image'),
        provider: z.string(),
        goal: z.string(),
        imagePath: z.string(),
        mimeType: z.string(),
        analysis: z.string(),
        truncated: z.boolean(),
        originalLength: z.number().int().nonnegative(),
        returnedLength: z.number().int().nonnegative(),
    })
    .strict();
export type InspectImageOutput = z.infer<typeof inspectImageOutputSchema>;

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

const ACCEPTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function loadSingleImage(
    input: InspectImageInput,
    maxImageBytes: number,
): { readonly image: VisionImage; readonly source: string } {
    if (input.file_path !== undefined) {
        if (/^https?:\/\//i.test(input.file_path)) {
            throw inspectFailure(
                `Remote URLs are not supported. Download the file first or use a local path: ${input.file_path}`,
            );
        }
        let stats: { size: number };
        try {
            stats = statSync(input.file_path);
        } catch (error: unknown) {
            const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
            if (code === 'ENOENT') {
                throw inspectFailure(`File not found: ${input.file_path}`);
            }
            throw inspectFailure(`Failed to stat ${input.file_path}: ${errorMessage(error)}`);
        }
        void stats;
        let bytes: Buffer;
        try {
            bytes = readFileSync(input.file_path);
        } catch (error: unknown) {
            const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
            if (code === 'ENOENT') {
                throw inspectFailure(`File not found: ${input.file_path}`);
            }
            throw inspectFailure(`Failed to read ${input.file_path}: ${errorMessage(error)}`);
        }
        assertImageBytes(bytes, maxImageBytes, input.file_path);
        const mimeType = inferMimeTypeFromFilePath(input.file_path);
        if (!ACCEPTED_IMAGE_MIMES.has(mimeType)) {
            throw inspectFailure(
                `inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content (got ${mimeType}).`,
            );
        }
        return {
            image: { mimeType, base64Data: bytes.toString('base64'), filename: basename(input.file_path) },
            source: input.file_path,
        };
    }
    if (input.image_data !== undefined) {
        const cleanData = stripDataUriPrefix(input.image_data);
        const decoded = Buffer.from(cleanData, 'base64');
        assertImageBytes(decoded, maxImageBytes, 'image_data');
        const mimeType = inferMimeTypeFromBase64(input.image_data);
        if (!ACCEPTED_IMAGE_MIMES.has(mimeType)) {
            throw inspectFailure(`inspect_image only supports PNG, JPEG, GIF, and WEBP images (detected ${mimeType}).`);
        }
        const ext = mimeType.split('/')[1] ?? 'png';
        return {
            image: { mimeType, base64Data: cleanData, filename: `clipboard-image.${ext}` },
            source: 'clipboard/pasted image',
        };
    }
    throw inspectFailure("Must provide either 'file_path' or 'image_data'.");
}

function assertImageBytes(bytes: Buffer, maxImageBytes: number, label: string): void {
    if (bytes.byteLength > maxImageBytes) {
        throw inspectFailure(
            `${label} is ${bytes.byteLength} bytes which exceeds the ${maxImageBytes}-byte image-size cap. ` +
                'Downscale the image before sending.',
        );
    }
}

// ---------------------------------------------------------------------------
// Tool options + registration
// ---------------------------------------------------------------------------

export type InspectImageToolOptions = {
    readonly providerPreference?: VisionProviderId | 'auto';
    readonly maxImageBytes?: number;
    readonly maxModelOutputChars?: number;
    readonly fetch?: VisionFetchFn;
    readonly timeoutMs?: number;
};

type ResolvedInspectImageToolOptions = {
    readonly providerPreference: VisionProviderId | 'auto';
    readonly maxImageBytes: number;
    readonly maxModelOutputChars: number;
    readonly fetch: VisionFetchFn;
    readonly timeoutMs: number;
};

export async function registerInspectImageTool(
    registry: ToolRegistry,
    options: InspectImageToolOptions = {},
): Promise<ToolAdvertisement> {
    return registry.register(createInspectImageToolRegistration(options));
}

export function createInspectImageToolRegistration(
    options: InspectImageToolOptions = {},
): ToolRegistration<InspectImageInput, InspectImageOutput> {
    const resolved = resolveInspectImageOptions(options);
    return {
        name: INSPECT_IMAGE_TOOL_NAME,
        description: INSPECT_IMAGE_DESCRIPTION,
        capabilityClasses: ['network'],
        parametersJsonSchema: inspectImageParametersJsonSchema(),
        inputSchema: inspectImageInputSchema as z.ZodType<InspectImageInput>,
        outputSchema: inspectImageOutputSchema as z.ZodType<InspectImageOutput>,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runInspectImage(resolved, input, context),
        toModelOutput: inspectImageModelOutput,
        guideline: INSPECT_IMAGE_GUIDELINE,
    };
}

function resolveInspectImageOptions(options: InspectImageToolOptions): ResolvedInspectImageToolOptions {
    return {
        providerPreference: options.providerPreference ?? 'auto',
        maxImageBytes: options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
        maxModelOutputChars: options.maxModelOutputChars ?? DEFAULT_MAX_MODEL_OUTPUT_CHARS,
        fetch:
            options.fetch ??
            (async () => {
                throw inspectFailure('inspect_image fetch seam was not wired');
            }),
        timeoutMs: options.timeoutMs ?? VISION_TIMEOUT_MS,
    };
}

function inspectImageParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Absolute path to the image file to analyze.' },
            image_data: {
                type: 'string',
                description: 'Base64-encoded image data (for clipboard/pasted images). May include a data: prefix.',
            },
            goal: { type: 'string', description: 'Question or analysis goal for the image.' },
        },
        required: ['goal'],
        additionalProperties: false,
    };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function runInspectImage(
    options: ResolvedInspectImageToolOptions,
    input: InspectImageInput,
    context: ToolExecutionContext,
): Promise<InspectImageOutput> {
    const { image, source } = loadSingleImage(input, options.maxImageBytes);

    const controller = wireAbort(context.signal);
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs);

    let analysis: string;
    try {
        analysis = await runVisionAnalysis(
            [image],
            input.goal,
            options.providerPreference,
            options.fetch,
            controller.signal,
        );
    } catch (error: unknown) {
        if (timedOut && error instanceof Error && error.name === 'AbortError') {
            throw inspectFailure(`inspect_image timed out after ${options.timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutHandle);
    }

    const limited = truncateOutput(analysis, options.maxModelOutputChars);
    return {
        kind: 'inspect_image',
        provider: options.providerPreference === 'auto' ? 'auto' : options.providerPreference,
        goal: input.goal,
        imagePath: source,
        mimeType: image.mimeType,
        analysis: limited.content,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
        returnedLength: limited.content.length,
    };
}

function inspectImageModelOutput(output: InspectImageOutput): string {
    const lines: string[] = [`## inspect_image (${output.imagePath}, ${output.mimeType})`];
    if (output.truncated) {
        lines.push('[output truncated]');
    }
    lines.push('', output.analysis);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
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

function inspectFailure(message: string): ToolExecutionError {
    const error: ProtocolError = { code: 'tool_failed', message, retryable: false };
    return new ToolExecutionError(error);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export { visionCredentialHint as inspectImageCredentialHint };
