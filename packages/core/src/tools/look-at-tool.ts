import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import type { z } from 'zod';
import { lookAtFailure } from './look-at-errors';
import { prepareLookAtInput } from './look-at-input';
import {
    type LookAtInput,
    type LookAtOutput,
    lookAtInputSchema,
    lookAtOutputSchema,
    lookAtParametersJsonSchema,
} from './look-at-schemas';
import { createWorkspaceGuard, type WorkspaceGuard } from './read-tools-paths';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry';
import type { ToolExecutionContext } from './tool-registry-types';
import { truncateOutput } from './truncate';
import { defaultVisionFetch, runVisionAnalysis, type VisionFetchFn } from './vision-analysis';
import { resolveVisionProviderChain, type VisionImage, type VisionProvider } from './vision-providers';
import { type VisionProviderId, visionCredentialHint } from './vision-schemas';

export { lookAtErrorMessage as errorMessage, lookAtFailure } from './look-at-errors';
export {
    inferMimeTypeFromBase64,
    inferMimeTypeFromFilePath,
    type PreparedVisionInput,
    type PrepareVisionResult,
    prepareLookAtInput,
    stripDataUriPrefix,
} from './look-at-input';
export { type LookAtInput, type LookAtOutput, lookAtInputSchema, lookAtOutputSchema } from './look-at-schemas';
export { defaultVisionFetch, runVisionAnalysis, type VisionFetchFn } from './vision-analysis';

const LOOK_AT_TOOL_NAME = 'look_at';
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
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

export type LookAtToolOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
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
    options: LookAtToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(createLookAtToolRegistration(options));
}

export function createLookAtToolRegistration(options: LookAtToolOptions): ToolRegistration<LookAtInput, LookAtOutput> {
    const resolved = resolveLookAtOptions(options);
    const guard = createWorkspaceGuard(options.workspaceRoot);
    return {
        name: LOOK_AT_TOOL_NAME,
        description: LOOK_AT_DESCRIPTION,
        capabilityClasses: ['network'],
        parametersJsonSchema: lookAtParametersJsonSchema(),
        inputSchema: lookAtInputSchema as z.ZodType<LookAtInput>,
        outputSchema: lookAtOutputSchema as z.ZodType<LookAtOutput>,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runLookAt(resolved, options, guard, input, context),
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

async function runLookAt(
    options: ResolvedLookAtToolOptions,
    authority: LookAtToolOptions,
    guardPromise: ReturnType<typeof createWorkspaceGuard>,
    input: LookAtInput,
    context: ToolExecutionContext,
): Promise<LookAtOutput> {
    assertVisionCredentialConfigured(options.providerPreference);
    const guard = await guardPromise;
    const containedInput = await resolveLookAtFilePaths(authority, guard, input, context.toolCallId);
    const prepared = prepareLookAtInput(containedInput, options.maxImageBytes);
    if (!prepared.ok) throw lookAtFailure(prepared.error, false);
    await requireVisionPermission(authority, context.toolCallId, 'network', ['vision-provider'], guard.root);
    const controller = wireAbort(context.signal);
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs);
    let analysis: string;
    try {
        analysis = await runVisionAnalysis(
            prepared.value.images,
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
        sourceDescription: prepared.value.sourceDescription,
        analysis: limited.content,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
        returnedLength: limited.content.length,
    };
}

async function resolveLookAtFilePaths(
    options: LookAtToolOptions,
    guard: WorkspaceGuard,
    input: LookAtInput,
    toolCallId: string,
): Promise<LookAtInput> {
    const requestedPaths = input.file_paths ?? (input.file_path !== undefined ? [input.file_path] : []);
    if (requestedPaths.length === 0 || requestedPaths.some((path) => /^https?:\/\//i.test(path))) return input;
    await requireVisionPermission(options, toolCallId, 'read', requestedPaths, guard.root);
    const resolvedPaths: string[] = [];
    for (const path of requestedPaths) {
        let target: Awaited<ReturnType<WorkspaceGuard['resolveExisting']>>;
        try {
            target = await guard.resolveExisting(path);
        } catch (error: unknown) {
            if (error instanceof ToolExecutionError && error.error.message.includes('path does not exist')) {
                throw lookAtFailure(`File not found: ${path}`, false);
            }
            throw error;
        }
        if (!target.stats.isFile()) throw lookAtFailure(`target is not a file: ${path}`, false);
        resolvedPaths.push(target.absolutePath);
    }
    if (input.file_paths !== undefined) return { ...input, file_paths: resolvedPaths };
    const resolvedPath = resolvedPaths[0];
    return resolvedPath === undefined ? input : { ...input, file_path: resolvedPath };
}

async function requireVisionPermission(
    options: LookAtToolOptions,
    toolCallId: string,
    permission: 'read' | 'network',
    patterns: readonly string[],
    workspaceRoot: string,
): Promise<void> {
    const decision = await requestToolPermission(
        options.requestPermission,
        permissionRequest({
            toolCallId: `${toolCallId}.${permission}`,
            action: LOOK_AT_TOOL_NAME,
            reason: permission === 'read' ? 'read media files from the workspace' : 'send media to a vision provider',
            permission,
            patterns,
            workspaceRoot,
        }),
    );
    if (decision.status === 'allow') return;
    const code = decision.status === 'deny' ? 'approval_denied' : 'approval_required';
    throw lookAtFailure(`${code}: ${decision.reason ?? `${LOOK_AT_TOOL_NAME} ${permission} denied`}`, false);
}

function assertVisionCredentialConfigured(preference: VisionProviderId | 'auto'): void {
    if (resolveVisionProviderChain(preference).length === 0) {
        throw lookAtFailure(
            `No vision provider credential is configured. Set one of: ${visionCredentialHint()}.`,
            false,
        );
    }
}

function lookAtModelOutput(output: LookAtOutput): string {
    const lines: string[] = [`## look_at analysis (${output.sourceDescription})`];
    if (output.truncated) lines.push('[output truncated]');
    lines.push('', output.analysis);
    return lines.join('\n');
}

function wireAbort(signal: AbortSignal): AbortController {
    const controller = new AbortController();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
    return controller;
}

export {
    DEFAULT_MAX_IMAGE_BYTES as LOOK_AT_DEFAULT_MAX_IMAGE_BYTES,
    resolveVisionProviderChain as resolveLookAtVisionChain,
    type VisionImage,
    type VisionProvider,
};
