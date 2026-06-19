import { defaultModelProviderSelection, getRuntimeModelProviderCatalog } from '@mission-control/config';
import {
    AgentRuntime,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createCodingAgentNodeRegistry,
    createGraphTurnRunner,
    PermissionGateError,
    type ProviderAdapter,
    type SdkModelResolver,
} from '@mission-control/core';
import type { AbgGraphSpec, AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { type AgentUIRenderer, InkRenderer, JsonRenderer, PlainRenderer } from '../ui/renderers.js';
import type { NonInteractiveAutomationPolicy } from './cli-runtime-options.js';
import { createCliRuntimeOptions } from './cli-runtime-options.js';
import { buildCodingAgentSystemPromptEnv, loadTrustedProjectInstructionResources } from './coding-agent-context.js';
import { type ChatInput, type ChatOutput, type ModelSelector, runInteractiveChatSession } from './interactive-chat.js';
import { createModelChoices, type ModelChoice } from './interactive-chat-model.js';
import { createDefaultModelDiscovery, type ModelDiscovery } from './model-discovery.js';
import { createCliProviderForSelection } from './provider-factory.js';
import { readGraphFile, validateGraphModelOptions, validateModelProviderSelection } from './run-agent-graph.js';
import {
    buildCodingAgentGraphForSelection,
    resolveGraphSdkModel,
    runCodingPromptOnGraph,
} from './run-agent-graph-prompt.js';
import { runOwnerPrompt } from './run-agent-owner-prompt.js';
import { createRunEventRecorder } from './run-agent-session.js';

export { createCliProviderForSelection } from './provider-factory.js';

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
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
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
        }),
    );
    if (shouldRunChat) {
        const recorder = await createRunEventRecorder(args, { workspaceRoot });
        const emitRuntimeEvent = (event: AgentEvent) => {
            const recorded = recorder.record(event);
            options.onRuntimeEvent?.(recorded);
        };
        const observeStoredEvent = (event: AgentEvent) => {
            options.onRuntimeEvent?.(event);
        };
        const unsubscribeRuntimeEvents = runtime.onEvent(emitRuntimeEvent);
        let didStart = false;
        try {
            const session = await runtime.start();
            didStart = true;
            const sessionStore = recorder.currentStore();
            return await runInteractiveChatSession(runtime, {
                modelProviderSelection: selectedModelProvider,
                provider,
                sessionId: args.sessionId ?? recorder.currentSessionId() ?? session.id,
                workspaceRoot,
                modelChoices: await listAuthenticatedModelChoices(
                    authStore,
                    options.modelDiscovery ?? createDefaultModelDiscovery(),
                ),
                emitEvent: emitRuntimeEvent,
                observeStoredEvent,
                switchSessionStore: recorder.switchSession,
                ...(sessionStore !== undefined ? { sessionStore } : {}),
                ...(options.provider === undefined ? { resolveProviderForSelection: createProvider } : {}),
                persistModelProviderSelection: async (selection) => {
                    await authStore.setDefaultSelection(selection);
                },
                ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                ...(options.chatInput !== undefined ? { input: options.chatInput } : {}),
                ...(options.chatOutput !== undefined ? { output: options.chatOutput } : {}),
                ...(options.selectModel !== undefined ? { selectModel: options.selectModel } : {}),
                // Wire the graph into the interactive path. The flat loop is gone; the ABG graph
                // is the only engine. `resolveSdkModel` is required (resolved below per turn).
                engine: 'graph',
                ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
            });
        } finally {
            if (didStart) {
                await runtime.stop();
            }
            unsubscribeRuntimeEvents?.();
            await recorder.close();
        }
    }

    const recorder = await createRunEventRecorder(args, { workspaceRoot });
    const renderer = createRenderer(args.mode);
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
    try {
        await renderer.start(runtime);
        await runtime.start();
        didStart = true;
        try {
            if (graph !== undefined) {
                await runtime.runGraph(graph);
            } else if (
                args.prompt !== undefined &&
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
                    prompt: args.prompt,
                    emitEvent: emitRuntimeEvent,
                    observeStoredEvent,
                    resolveSdkModel,
                    createTurnRunner: ({ toolRegistry }) =>
                        createGraphTurnRunner({
                            graph: buildCodingAgentGraphForSelection(selectedModelProvider),
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
                        }),
                    ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                    ...(options.nonInteractiveAutomationPolicy !== undefined
                        ? { nonInteractiveAutomationPolicy: options.nonInteractiveAutomationPolicy }
                        : {}),
                    throwOnTerminalFailure: args.mode === 'plain',
                });
            } else if (args.prompt !== undefined) {
                await runCodingPromptOnGraph({
                    runtime,
                    selection: selectedModelProvider,
                    prompt: args.prompt,
                    workspaceRoot,
                    ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
                    authStore,
                    ...(options.provider !== undefined ? { provider: options.provider } : {}),
                    ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                });
            } else {
                await runtime.runDemoTask();
            }
        } catch (error: unknown) {
            if (!(error instanceof PermissionGateError)) {
                throw error;
            }
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
    }
    return renderer.getOutput();
}

function shouldRunInteractiveChat(args: CliArgs, graph: AbgGraphSpec | undefined, options: RunAgentOptions): boolean {
    return (
        graph === undefined &&
        args.mode === 'ink' &&
        (options.chatInput !== undefined || (process.stdin.isTTY === true && process.stdout.isTTY === true))
    );
}

async function resolveModelProviderSelection(
    args: CliArgs,
    authStore: ProviderAuthStore,
): Promise<ModelProviderSelection | undefined> {
    if (args.modelProviderSelection !== undefined) {
        return args.modelProviderSelection;
    }
    return authStore.getDefaultSelection();
}

async function listAuthenticatedProviderIDs(authStore: ProviderAuthStore): Promise<readonly string[]> {
    const summaries = await authStore.listCredentialSummaries();
    return summaries.filter((summary) => summary.authenticated).map((summary) => summary.providerID);
}

async function listAuthenticatedModelChoices(
    authStore: ProviderAuthStore,
    modelDiscovery: ModelDiscovery,
): Promise<readonly ModelChoice[]> {
    const authFile = await authStore.readAuthFile();
    const providerIDs = await listAuthenticatedProviderIDs(authStore);
    const runtimeCatalog = await getRuntimeModelProviderCatalog();
    const baseChoices = createModelChoices({ catalog: runtimeCatalog, providerIDs });
    const choices: ModelChoice[] = [];

    for (const providerID of providerIDs) {
        const provider = runtimeCatalog.find((entry) => entry.id === providerID);
        const credential = authFile.credentials[providerID];
        const providerChoices = baseChoices.filter((choice) => choice.selection.providerID === providerID);
        if (provider === undefined || credential === undefined) {
            choices.push(...providerChoices);
            continue;
        }

        const discoveredModelIDs = await modelDiscovery({ provider, credential });
        if (discoveredModelIDs === undefined) {
            choices.push(...providerChoices);
            continue;
        }
        const catalogModelIDs = new Set(providerChoices.map((choice) => choice.selection.modelID));
        const extraChoices: ModelChoice[] = discoveredModelIDs
            .filter((id) => !catalogModelIDs.has(id))
            .map((id) => {
                const label = `${providerID}/${id}`;
                return {
                    id: label,
                    label,
                    selection: { providerID, modelID: id },
                    capabilityStatus: provider.capability.status,
                    availableForCoding: true,
                };
            });
        choices.push(...providerChoices, ...extraChoices);
    }

    return choices;
}

function createProviderForSelection(selection: ModelProviderSelection, authStore: ProviderAuthStore): ProviderAdapter {
    return createCliProviderForSelection(selection, authStore);
}

function createRenderer(mode: CliArgs['mode']): AgentUIRenderer {
    switch (mode) {
        case 'plain':
            return new PlainRenderer();
        case 'json':
        case 'jsonl':
            return new JsonRenderer();
        case 'ink':
            return new InkRenderer();
        default:
            return assertNever(mode);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unexpected CLI mode: ${String(value)}`);
}
