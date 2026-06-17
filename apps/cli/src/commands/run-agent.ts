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
    const nonInteractiveEngine = resolveNonInteractiveEngine(args.engine);
    const interactiveEngine = resolveInteractiveEngine(args.engine);
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
                sessionId: args.sessionId ?? session.id,
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
                // Wire the graph into the interactive path only when explicitly selected (opt-in); the flat
                // loop remains the interactive default (see resolveInteractiveEngine).
                ...(interactiveEngine === 'graph' ? { engine: interactiveEngine } : {}),
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
                nonInteractiveEngine === 'graph' &&
                args.prompt !== undefined &&
                recorder.currentStore() !== undefined &&
                recorder.currentSessionId() !== undefined
            ) {
                // `--engine graph --session <id>`: drive the ABG coding-agent graph through the SAME
                // session owner that powers the flat path's queue/steer/resume. The graph turn runner
                // is built over the owner's permission-gated tool surface so the two engines share
                // approval/blocking behavior; the coordinator owns queue/steer/resume around graph runs.
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
                await runOwnerPrompt({
                    sessionId,
                    store: sessionStore,
                    provider,
                    modelProviderSelection: selectedModelProvider,
                    workspaceRoot,
                    prompt: args.prompt,
                    emitEvent: emitRuntimeEvent,
                    observeStoredEvent,
                    createTurnRunner: ({ toolRegistry }) =>
                        createGraphTurnRunner({
                            graph: buildCodingAgentGraphForSelection(selectedModelProvider),
                            sessionId,
                            now: () => new Date().toISOString(),
                            modelProviderSelection: selectedModelProvider,
                            registry: createCodingAgentNodeRegistry(),
                            resolveSdkModel,
                            toolRegistry,
                            // Match the flat owner path's `haltOnFailedToolSettlement: true`
                            // (runOwnerPrompt) so a denied / non-allowlisted command terminates the
                            // graph immediately instead of looping until the node-run budget.
                            haltOnFailedToolSettlement: true,
                        }),
                    ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                    ...(options.nonInteractiveAutomationPolicy !== undefined
                        ? { nonInteractiveAutomationPolicy: options.nonInteractiveAutomationPolicy }
                        : {}),
                    throwOnTerminalFailure: args.mode === 'plain',
                });
            } else if (nonInteractiveEngine === 'graph' && args.prompt !== undefined) {
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
            } else if (
                args.prompt !== undefined &&
                recorder.currentStore() !== undefined &&
                recorder.currentSessionId() !== undefined
            ) {
                const sessionStore = recorder.currentStore();
                const sessionId = recorder.currentSessionId();
                if (sessionStore === undefined || sessionId === undefined) {
                    throw new TypeError('durable session recorder became unavailable while running a prompt');
                }
                await runOwnerPrompt({
                    sessionId,
                    store: sessionStore,
                    provider,
                    modelProviderSelection: selectedModelProvider,
                    workspaceRoot,
                    prompt: args.prompt,
                    emitEvent: emitRuntimeEvent,
                    observeStoredEvent,
                    ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                    ...(options.nonInteractiveAutomationPolicy !== undefined
                        ? { nonInteractiveAutomationPolicy: options.nonInteractiveAutomationPolicy }
                        : {}),
                    throwOnTerminalFailure: args.mode === 'plain',
                });
            } else if (args.prompt !== undefined) {
                await runtime.runPromptTask(args.prompt);
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

/**
 * Resolve the execution engine for NON-INTERACTIVE runs (`--prompt`, `--no-tui`, `--json`). `--engine`
 * wins; otherwise the ABG coding-agent GRAPH is the default (the flip landed in 3f780c7). The flat
 * provider-turn loop is the opt-out escape hatch: `MC_USE_FLAT=1` (or back-compat `MC_USE_GRAPH=0`).
 * `MC_USE_GRAPH=1` is a now-redundant explicit opt-in.
 */
function resolveNonInteractiveEngine(engine: CliArgs['engine']): 'graph' | 'flat' {
    if (engine !== undefined) {
        return engine;
    }
    if (process.env['MC_USE_FLAT'] === '1' || process.env['MC_USE_GRAPH'] === '0') {
        return 'flat';
    }
    return 'graph';
}

/**
 * Resolve the execution engine for INTERACTIVE chat runs. The graph is wired into the interactive path
 * (strangler-fig) but is OPT-IN for now (`--engine graph` / `MC_USE_GRAPH=1`): the interactive graph
 * path is newer than the non-interactive flip, so the flat loop stays the interactive default until the
 * graph path is verified in real use. The escape-hatch flags (`MC_USE_FLAT=1`, back-compat
 * `MC_USE_GRAPH=0`) still force flat. Flipping the interactive default to graph is a one-line change
 * here (tracked in task #47).
 */
function resolveInteractiveEngine(engine: CliArgs['engine']): 'graph' | 'flat' {
    if (engine !== undefined) {
        return engine;
    }
    if (process.env['MC_USE_FLAT'] === '1' || process.env['MC_USE_GRAPH'] === '0') {
        return 'flat';
    }
    if (process.env['MC_USE_GRAPH'] === '1') {
        return 'graph';
    }
    return 'flat';
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
