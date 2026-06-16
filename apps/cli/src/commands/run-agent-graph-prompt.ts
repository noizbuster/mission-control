/**
 * `--engine graph` cutover path — additive, non-destructive (plan §16, step 1+2).
 *
 * Runs the default coding-agent graph against the selected provider through the AI-SDK
 * (`resolveSdkModel` bridge), with the full non-interactive tool surface. The flat
 * provider-turn loop stays the default; this path is opt-in via `--engine graph` (or
 * `MC_USE_GRAPH=1`). Nothing here retires the flat path — it only constructs the graph
 * wiring (registry + resolveSdkModel + toolRegistry + initialMessages) that `run-agent.ts`
 * previously omitted, so `AgentRuntime.runGraph` drives a REAL provider instead of the
 * mock registry.
 *
 * Deliberate limitations (tracked separately, not blockers for this seam):
 * - Providers with no AI-SDK mapping (e.g. `local`) are rejected eagerly with a clear error.
 * - Durable-store envelope parity and queue/steer/resume orchestration are flat-path-only;
 *   this path records emitted events via the runtime bus but does not yet match the flat
 *   loop's full session orchestration.
 */
import {
    type AbgGraphRunResult,
    type AgentRuntime,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createCodingAgentGraph,
    createCodingAgentNodeRegistry,
    createSdkModelResolver,
    type SdkModelResolver,
    SdkModelResolverError,
    type ToolRegistry,
} from '@mission-control/core';
import type { AbgGraphSpec, AbgNodeModelOptions, ModelProviderSelection } from '@mission-control/protocol';
import type { ProviderAuthStore } from '../auth-store.js';
import { createCliProviderCredentialResolver } from '../provider-credential-resolver.js';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';

export type RunCodingPromptOnGraphInput = {
    readonly runtime: AgentRuntime;
    readonly selection: ModelProviderSelection;
    readonly prompt: string;
    readonly workspaceRoot: string;
    /**
     * Injected SDK model resolver (tests / scripted models). When omitted, the resolver is
     * built from `authStore` for the selection's provider via `createSdkModelResolver`.
     */
    readonly resolveSdkModel?: SdkModelResolver;
    /** Required when `resolveSdkModel` is omitted (resolves the provider credential). */
    readonly authStore?: ProviderAuthStore;
    /**
     * Injected tool surface (tests). When omitted, the full non-interactive coding tool
     * registry is built from `runtime.requestPermission` + `workspaceRoot`.
     */
    readonly toolRegistry?: ToolRegistry;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

/** Build the coding-agent graph wiring and drive it through the runtime. Non-destructive. */
export async function runCodingPromptOnGraph(input: RunCodingPromptOnGraphInput): Promise<AbgGraphRunResult> {
    const resolveSdkModel = await resolveGraphSdkModel({
        selection: input.selection,
        ...(input.resolveSdkModel !== undefined ? { resolveSdkModel: input.resolveSdkModel } : {}),
        ...(input.authStore !== undefined ? { authStore: input.authStore } : {}),
    });

    const toolRegistry =
        input.toolRegistry ??
        (await createNonInteractiveToolRegistry({
            workspaceRoot: input.workspaceRoot,
            requestPermission: (request) => input.runtime.requestPermission(request),
            ...(input.commandExecutor !== undefined ? { commandExecutor: input.commandExecutor } : {}),
        }));

    return input.runtime.runGraph(buildCodingAgentGraphForSelection(input.selection), undefined, {
        registry: createCodingAgentNodeRegistry(),
        resolveSdkModel,
        toolRegistry,
        initialMessages: [{ role: 'user', content: input.prompt }],
    });
}

/**
 * Minimal input for resolving the AI-SDK model used by the graph engine. Shared by the one-shot
 * `--engine graph` path and the `--engine graph --session` path so the resolver build + eager
 * validation (clear error for providers with no AI-SDK mapping) is identical in both.
 */
export type GraphSdkModelResolverInput = {
    readonly selection: ModelProviderSelection;
    readonly resolveSdkModel?: SdkModelResolver;
    readonly authStore?: ProviderAuthStore;
};

/**
 * Resolve the SDK model for the graph engine, validating eagerly so an unsupported provider
 * (e.g. `local`) fails with a clear error before the graph starts. Injected resolvers win;
 * otherwise the resolver is built from `authStore`.
 */
export async function resolveGraphSdkModel(input: GraphSdkModelResolverInput): Promise<SdkModelResolver> {
    const resolveSdkModel = input.resolveSdkModel ?? (await buildSdkModelResolver(input));
    validateResolverForSelection(resolveSdkModel, input.selection);
    return resolveSdkModel;
}

/** Build the default coding-agent graph bound to a model selection (shared by both graph paths). */
export function buildCodingAgentGraphForSelection(selection: ModelProviderSelection): AbgGraphSpec {
    return createCodingAgentGraph({ model: selectionToModelOptions(selection) });
}

async function buildSdkModelResolver(input: GraphSdkModelResolverInput): Promise<SdkModelResolver> {
    if (input.authStore === undefined) {
        throw new SdkModelResolverError(
            'graph engine requires either an injected resolver or an auth store to resolve credentials',
        );
    }
    return createSdkModelResolver({
        providerID: input.selection.providerID,
        credentialResolver: createCliProviderCredentialResolver(input.authStore),
    });
}

/**
 * Eagerly invoke the resolver once so an unsupported provider (e.g. `local`) fails with a
 * clear CLI error before the graph starts, instead of a cryptic node failure mid-run.
 */
function validateResolverForSelection(resolver: SdkModelResolver, selection: ModelProviderSelection): void {
    try {
        resolver(selectionToModelOptions(selection));
    } catch (error) {
        if (error instanceof SdkModelResolverError) {
            throw new SdkModelResolverError(
                `--engine graph cannot drive provider "${selection.providerID}" — no AI-SDK mapping. ` +
                    'The graph engine supports AI-SDK-backed providers (anthropic, openai, openai-responses, ' +
                    'openai-compatible, google, google-gemini). Use the default flat engine instead.',
            );
        }
        throw error;
    }
}

function selectionToModelOptions(selection: ModelProviderSelection): AbgNodeModelOptions {
    return {
        providerID: selection.providerID,
        modelID: selection.modelID,
        ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
    };
}
