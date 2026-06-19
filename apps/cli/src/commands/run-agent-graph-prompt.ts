/**
 * Graph engine path (plan §16, the strangler-fig cutover seam — now the only engine).
 *
 * Runs the default coding-agent graph against the selected provider through the AI-SDK
 * (`resolveSdkModel` bridge), with the full non-interactive tool surface. This path only
 * constructs the graph wiring (registry + resolveSdkModel + toolRegistry + initialMessages) so
 * `AgentRuntime.runGraph` drives a REAL provider instead of the mock registry.
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
    type ProviderAdapter,
    type SdkModelResolver,
    SdkModelResolverError,
    type ToolRegistry,
    wrapFlatProviderAsSdkModel,
} from '@mission-control/core';
import type { AbgGraphSpec, AbgNodeModelOptions, ModelProviderSelection } from '@mission-control/protocol';
import type { ProviderAuthStore } from '../auth-store.js';
import { buildCodingAgentSystemPromptEnv, loadTrustedProjectInstructionResources } from './coding-agent-context.js';
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
     * Injected flat provider (the flat engine's `ProviderAdapter`). When present, the graph engine
     * drives THIS provider via the flat→AI-SDK bridge instead of resolving a real provider from the
     * auth store — so a credential-free scripted/deterministic provider runs unchanged on the graph.
     */
    readonly provider?: ProviderAdapter;
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
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
    });

    const toolRegistry =
        input.toolRegistry ??
        (await createNonInteractiveToolRegistry({
            workspaceRoot: input.workspaceRoot,
            requestPermission: (request) => input.runtime.requestPermission(request),
            ...(input.commandExecutor !== undefined ? { commandExecutor: input.commandExecutor } : {}),
        }));

    const systemPromptEnv = await buildCodingAgentSystemPromptEnv({
        workspaceRoot: input.workspaceRoot,
        modelId: input.selection.modelID,
    });
    const projectInstructionResources = await loadTrustedProjectInstructionResources(input.workspaceRoot);

    return input.runtime.runGraph(buildCodingAgentGraphForSelection(input.selection), undefined, {
        registry: createCodingAgentNodeRegistry(),
        resolveSdkModel,
        toolRegistry,
        initialMessages: [{ role: 'user', content: input.prompt }],
        // Match the flat owner path's `haltOnFailedToolSettlement: true` (runOwnerPrompt) so a
        // denied / non-allowlisted command terminates the graph immediately instead of looping
        // until the node-run budget.
        haltOnFailedToolSettlement: true,
        systemPromptEnv,
        ...(projectInstructionResources.length > 0 ? { projectInstructionResources } : {}),
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
    readonly provider?: ProviderAdapter;
};

/**
 * Resolve the SDK model for the graph engine, validating eagerly so an unsupported provider
 * (e.g. `local`) fails with a clear error before the graph starts. Precedence: an injected
 * `resolveSdkModel` wins (tests / scripted models — it is the explicit override); then an injected
 * flat `ProviderAdapter` is wrapped via the bridge (drives that provider on the graph — no
 * credential/auth resolution); otherwise the resolver is built from `authStore`.
 */
export async function resolveGraphSdkModel(input: GraphSdkModelResolverInput): Promise<SdkModelResolver> {
    if (input.resolveSdkModel !== undefined) {
        validateResolverForSelection(input.resolveSdkModel, input.selection);
        return input.resolveSdkModel;
    }
    if (input.provider !== undefined) {
        return bridgeResolverFromProvider(input.provider, input.selection);
    }
    const resolveSdkModel = await buildSdkModelResolver(input);
    validateResolverForSelection(resolveSdkModel, input.selection);
    return resolveSdkModel;
}

/**
 * Build an `SdkModelResolver` that drives an injected flat `ProviderAdapter` through the bridge.
 * The provider is already constructed (credential-free scripted/deterministic), so no auth-store
 * resolution or eager unsupported-provider validation applies — the bridge adapts every flat provider.
 */
function bridgeResolverFromProvider(provider: ProviderAdapter, selection: ModelProviderSelection): SdkModelResolver {
    return (options) =>
        wrapFlatProviderAsSdkModel({
            provider,
            providerID: options.providerID ?? selection.providerID,
            modelID: options.modelID,
            ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
        });
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
                `graph engine cannot drive provider "${selection.providerID}" — no AI-SDK mapping. ` +
                    'The graph engine supports AI-SDK-backed providers (anthropic, openai, openai-responses, ' +
                    'openai-compatible, google, google-gemini).',
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
