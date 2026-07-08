import { defaultModelProviderSelection } from '@mission-control/config';
import {
    AgentRuntime,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createCodingAgentNodeRegistry,
    createGraphTurnRunner,
    createPersistentStore,
    PermissionGateError,
    type ProviderAdapter,
    resolveMissionControlDataDir,
    type SdkModelResolver,
} from '@mission-control/core';
import type { AbgGraphSpec, AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { closeTreeSitterClient } from '@mission-control/tui/highlight';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import type { NonInteractiveAutomationPolicy } from './cli-runtime-options.js';
import { createCliRuntimeOptions } from './cli-runtime-options.js';
import { buildCodingAgentSystemPromptEnv, loadTrustedProjectInstructionResources } from './coding-agent-context.js';
import type { ChatInput, ChatOutput, ModelSelector, PlainPromptGraph } from './interactive-chat.js';
import type { ModelDiscovery } from './model-discovery.js';
import { loadPricingTable } from './pricing-table-store.js';
import { createCliProviderForSelection } from './provider-factory.js';
import { readGraphFile, validateGraphModelOptions, validateModelProviderSelection } from './run-agent-graph.js';
import {
    buildCodingAgentGraphForSelection,
    resolveGraphSdkModel,
    runCodingPromptOnGraph,
} from './run-agent-graph-prompt.js';
import { runInteractiveAgent } from './run-agent-interactive.js';
import { buildAgentModelLookup, resolveModelProviderSelection } from './run-agent-model-selection.js';
import { runOwnerPrompt } from './run-agent-owner-prompt.js';
import { closePersistentStore, createRenderer } from './run-agent-rendering.js';
import { createRunEventRecorder } from './run-agent-session.js';
import {
    beginNoninteractiveWorkflowRun,
    resolveNoninteractiveWorkflowSelection,
    settleNoninteractiveWorkflowRun,
    type WorkflowRunOutcome,
} from './run-agent-workflow.js';
import { resolveWorkspaceRoot } from './run-agent-workspace.js';

export { createCliProviderForSelection } from './provider-factory.js';
export {
    resolveWorkflowInvocation,
    type WorkflowInvocation,
    type WorkflowInvocationInput,
} from './run-agent-workflow.js';
export { detectWorkspaceRoot, resolveWorkspaceRoot } from './run-agent-workspace.js';

export type RunAgentOptions = {
    readonly authStore?: ProviderAuthStore;
    readonly chatInput?: ChatInput;
    readonly chatOutput?: ChatOutput;
    readonly selectModel?: ModelSelector;
    readonly modelDiscovery?: ModelDiscovery;
    readonly onRuntimeEvent?: (event: AgentEvent) => void;
    readonly provider?: ProviderAdapter;
    readonly createProvider?: (selection: ModelProviderSelection) => ProviderAdapter;
    /**
     * Injected SDK model resolver for the `--engine graph` path (tests / scripted models).
     * When unset, the graph path builds the resolver from the auth store for the selection.
     */
    readonly resolveSdkModel?: SdkModelResolver;
    readonly workspaceRoot?: string;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly nonInteractiveAutomationPolicy?: NonInteractiveAutomationPolicy;
    readonly plainPromptGraph?: PlainPromptGraph;
};

export async function runAgent(args: CliArgs, options: RunAgentOptions = {}): Promise<string> {
    const authStore = options.authStore ?? createProviderAuthStore();
    const modelProviderSelection = validateModelProviderSelection(await resolveModelProviderSelection(args, authStore));
    const graph = args.graphPath !== undefined ? await readGraphFile(args.graphPath) : undefined;
    if (graph !== undefined) {
        validateGraphModelOptions(graph);
    }
    const selectedModelProvider = modelProviderSelection ?? defaultModelProviderSelection;
    const shouldRunChat = shouldRunInteractiveChat(args, graph, options);
    const createProvider = options.createProvider ?? ((selection) => createProviderForSelection(selection, authStore));
    const provider = options.provider ?? createProvider(selectedModelProvider);
    const workspaceRoot = options.workspaceRoot ?? resolveWorkspaceRoot(args.workspacePath);
    const agentModelLookup = await buildAgentModelLookup(workspaceRoot);
    const persistentStore = await createPersistentStore(resolveMissionControlDataDir());
    const runtime = new AgentRuntime(
        createCliRuntimeOptions({
            ...(args.useNative !== undefined ? { useNative: args.useNative } : {}),
            ...(modelProviderSelection !== undefined ? { modelProviderSelection } : {}),
            provider,
            workspaceRoot,
            ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
            ...(options.nonInteractiveAutomationPolicy !== undefined
                ? { nonInteractiveAutomationPolicy: options.nonInteractiveAutomationPolicy }
                : {}),
            ...(persistentStore !== undefined ? { persistentStore } : {}),
            ...(args.profileName !== undefined ? { profileName: args.profileName } : {}),
        }),
    );
    if (shouldRunChat) {
        return await runInteractiveAgent({
            args,
            runtime,
            authStore,
            provider,
            selectedModelProvider,
            createProvider,
            workspaceRoot,
            ...(persistentStore !== undefined ? { persistentStore } : { persistentStore: undefined }),
            options,
        });
    }

    const recorder = await createRunEventRecorder(args, { workspaceRoot });
    const renderer = createRenderer(args.mode, args.thinking);
    const unsubscribe = runtime.onEvent((event) => {
        renderer.render(recorder.record(event));
    });
    const emitRuntimeEvent = (event: AgentEvent) => {
        renderer.render(recorder.record(event));
    };
    const observeStoredEvent = (event: AgentEvent) => {
        renderer.render(event);
    };
    let didStart = false;
    const pricingTable = await loadPricingTable();
    const { effectivePrompt, workflowGraph, workflowSpec } = await resolveNoninteractiveWorkflowSelection({
        args,
        workspaceRoot,
        graph,
    });
    const workflowRun = await beginNoninteractiveWorkflowRun(workspaceRoot, workflowSpec);
    try {
        await renderer.start(runtime);
        await runtime.start();
        didStart = true;
        let workflowOutcome: WorkflowRunOutcome | undefined;
        try {
            if (graph !== undefined) {
                await runtime.runGraph(graph);
            } else if (
                effectivePrompt !== undefined &&
                recorder.currentStore() !== undefined &&
                recorder.currentSessionId() !== undefined
            ) {
                // `--prompt --session <id>` (or every prompt with a durable store): drive the ABG
                // coding-agent graph through the SAME session owner that powers queue/steer/resume.
                // The graph turn runner is built over the owner's permission-gated tool surface so
                // approval/blocking behavior is shared; the coordinator owns queue/steer/resume.
                const sessionStore = recorder.currentStore();
                const sessionId = recorder.currentSessionId();
                if (sessionStore === undefined || sessionId === undefined) {
                    throw new TypeError('durable session recorder became unavailable while running a prompt');
                }
                const resolveSdkModel = await resolveGraphSdkModel({
                    selection: selectedModelProvider,
                    ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
                    authStore,
                    ...(options.provider !== undefined ? { provider: options.provider } : {}),
                });
                const systemPromptEnv = await buildCodingAgentSystemPromptEnv({
                    workspaceRoot,
                    modelId: selectedModelProvider.modelID,
                });
                const projectInstructionResources = await loadTrustedProjectInstructionResources(workspaceRoot);
                await runOwnerPrompt({
                    sessionId,
                    store: sessionStore,
                    provider,
                    modelProviderSelection: selectedModelProvider,
                    workspaceRoot,
                    prompt: effectivePrompt,
                    emitEvent: emitRuntimeEvent,
                    observeStoredEvent,
                    resolveSdkModel,
                    createTurnRunner: ({ toolRegistry }) =>
                        createGraphTurnRunner({
                            graph: workflowGraph ?? buildCodingAgentGraphForSelection(selectedModelProvider),
                            sessionId,
                            now: () => new Date().toISOString(),
                            modelProviderSelection: selectedModelProvider,
                            registry: createCodingAgentNodeRegistry(),
                            resolveSdkModel,
                            toolRegistry,
                            // Fail-fast on denied / non-allowlisted commands so the graph terminates
                            // immediately instead of looping until the node-run budget.
                            haltOnFailedToolSettlement: true,
                            systemPromptEnv,
                            ...(projectInstructionResources.length > 0 ? { projectInstructionResources } : {}),
                            ...(pricingTable.length > 0 ? { pricingTable } : {}),
                        }),
                    ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                    ...(options.nonInteractiveAutomationPolicy !== undefined
                        ? { nonInteractiveAutomationPolicy: options.nonInteractiveAutomationPolicy }
                        : {}),
                    throwOnTerminalFailure: args.mode === 'plain',
                });
                workflowOutcome = { failed: false };
            } else if (effectivePrompt !== undefined) {
                const graphResult = await runCodingPromptOnGraph({
                    runtime,
                    selection: selectedModelProvider,
                    prompt: effectivePrompt,
                    workspaceRoot,
                    ...(workflowGraph !== undefined ? { graph: workflowGraph } : {}),
                    ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
                    authStore,
                    ...(options.provider !== undefined ? { provider: options.provider } : {}),
                    ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                    ...(pricingTable.length > 0 ? { pricingTable } : {}),
                    ...(agentModelLookup !== undefined ? { agentModelLookup } : {}),
                });
                workflowOutcome =
                    graphResult.status === 'failed'
                        ? { failed: true, reason: graphResult.reason ?? 'workflow graph run failed' }
                        : { failed: false };
            } else {
                await runtime.runDemoTask();
            }
        } catch (error: unknown) {
            if (!(error instanceof PermissionGateError)) {
                await settleNoninteractiveWorkflowRun(workflowRun, {
                    failed: true,
                    reason: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
            // A permission-gate denial aborts the turn but the CLI settles normally.
            // The workflow Run stays non-terminal: it paused on a permission boundary
            // rather than completing or failing, and the drain is not solved here.
            workflowOutcome = undefined;
        }
        if (workflowOutcome !== undefined) {
            await settleNoninteractiveWorkflowRun(workflowRun, workflowOutcome);
        }
        await runtime.stop();
        didStart = false;
    } finally {
        if (didStart) {
            await runtime.stop();
        }
        unsubscribe();
        try {
            await recorder.close();
        } finally {
            await renderer.stop();
        }
        closePersistentStore(persistentStore);
        await closeTreeSitterClient();
    }
    return renderer.streamedOutput === true ? '' : renderer.getOutput();
}

function shouldRunInteractiveChat(args: CliArgs, graph: AbgGraphSpec | undefined, options: RunAgentOptions): boolean {
    return (
        graph === undefined &&
        args.mode === 'tui' &&
        (options.chatInput !== undefined || (process.stdin.isTTY === true && process.stdout.isTTY === true))
    );
}

function createProviderForSelection(selection: ModelProviderSelection, authStore: ProviderAuthStore): ProviderAdapter {
    return createCliProviderForSelection(selection, authStore);
}
