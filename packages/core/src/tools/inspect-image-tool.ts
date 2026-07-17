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
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { z } from 'zod';
import { inspectFailure } from './inspect-image-errors';
import { loadSingleImage } from './inspect-image-input';
import { resolveLookAtVisionChain, runVisionAnalysis, type VisionFetchFn } from './look-at-tool';
import { createWorkspaceGuard, type WorkspaceGuard } from './read-tools-paths';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry';
import type { ToolExecutionContext } from './tool-registry-types';
import { truncateOutput } from './truncate';
import type { VisionProviderId } from './vision-schemas';
import { visionCredentialHint } from './vision-schemas';

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
// Tool options + registration
// ---------------------------------------------------------------------------

export type InspectImageToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
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
    options: InspectImageToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(createInspectImageToolRegistration(options));
}

export function createInspectImageToolRegistration(
    options: InspectImageToolOptions,
): ToolRegistration<InspectImageInput, InspectImageOutput> {
    const resolved = resolveInspectImageOptions(options);
    const guard = createWorkspaceGuard(options.workspaceRoot);
    return {
        name: INSPECT_IMAGE_TOOL_NAME,
        description: INSPECT_IMAGE_DESCRIPTION,
        capabilityClasses: ['network'],
        parametersJsonSchema: inspectImageParametersJsonSchema(),
        inputSchema: inspectImageInputSchema as z.ZodType<InspectImageInput>,
        outputSchema: inspectImageOutputSchema as z.ZodType<InspectImageOutput>,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runInspectImage(resolved, options, guard, input, context),
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
    authority: InspectImageToolOptions,
    guardPromise: ReturnType<typeof createWorkspaceGuard>,
    input: InspectImageInput,
    context: ToolExecutionContext,
): Promise<InspectImageOutput> {
    assertInspectImageCredentialConfigured(options.providerPreference);
    const guard = await guardPromise;
    const containedInput = await resolveInspectImagePath(authority, guard, input, context.toolCallId);
    const { image, source } = loadSingleImage(containedInput, options.maxImageBytes);
    await requireInspectImagePermission(authority, context.toolCallId, 'network', ['vision-provider'], guard.root);

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

async function resolveInspectImagePath(
    options: InspectImageToolOptions,
    guard: WorkspaceGuard,
    input: InspectImageInput,
    toolCallId: string,
): Promise<InspectImageInput> {
    if (input.file_path === undefined) return input;
    if (/^https?:\/\//i.test(input.file_path)) return input;
    await requireInspectImagePermission(options, toolCallId, 'read', [input.file_path], guard.root);
    const target = await guard.resolveExisting(input.file_path);
    if (!target.stats.isFile()) throw inspectFailure(`target is not a file: ${input.file_path}`);
    return { ...input, file_path: target.absolutePath };
}

async function requireInspectImagePermission(
    options: InspectImageToolOptions,
    toolCallId: string,
    permission: 'read' | 'network',
    patterns: readonly string[],
    workspaceRoot: string,
): Promise<void> {
    const decision = await requestToolPermission(
        options.requestPermission,
        permissionRequest({
            toolCallId: `${toolCallId}.${permission}`,
            action: INSPECT_IMAGE_TOOL_NAME,
            reason: permission === 'read' ? 'read an image from the workspace' : 'send an image to a vision provider',
            permission,
            patterns,
            workspaceRoot,
        }),
    );
    if (decision.status === 'allow') return;
    const code = decision.status === 'deny' ? 'approval_denied' : 'approval_required';
    throw inspectFailure(`${code}: ${decision.reason ?? `${INSPECT_IMAGE_TOOL_NAME} ${permission} denied`}`);
}

function assertInspectImageCredentialConfigured(preference: VisionProviderId | 'auto'): void {
    if (resolveLookAtVisionChain(preference).length === 0) {
        throw inspectFailure(`No vision provider credential is configured. Set one of: ${visionCredentialHint()}.`);
    }
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

export { visionCredentialHint as inspectImageCredentialHint };
