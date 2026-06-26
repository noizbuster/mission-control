import { defaultModelProviderSelection, getRuntimeModelProviderCatalog } from '@mission-control/config';
import {
    type AgentModelLookup,
    AgentRuntime,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createCodingAgentNodeRegistry,
    createGraphTurnRunner,
    createPersistentStore,
    discoverAgents,
    discoverWorkflows,
    PermissionGateError,
    type PersistentMemoryStore,
    PluginManager,
    type ProviderAdapter,
    registerBuiltinWorkflows,
    resolveMissionControlDataDir,
    resolveUserConfigDir,
    type SdkModelResolver,
    TursoPersistentStore,
    WorkflowRegistry,
} from '@mission-control/core';
import type { AbgGraphSpec, AbgNodeModelOptions, AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { closeTreeSitterClient } from '../components/markdown/highlight.js';
import { type AgentUIRenderer, JsonRenderer, PlainRenderer, TuiRenderer } from '../ui/renderers.js';
import { loadPersistedApprovalLevel, savePersistedApprovalLevel } from './approval-level-store.js';
import { splitCommandParts } from './chat-command-parts.js';
import type { NonInteractiveAutomationPolicy } from './cli-runtime-options.js';
import { createCliRuntimeOptions } from './cli-runtime-options.js';
import { buildCodingAgentSystemPromptEnv, loadTrustedProjectInstructionResources } from './coding-agent-context.js';
import { type ChatInput, type ChatOutput, type ModelSelector, runInteractiveChatSession } from './interactive-chat.js';
import { createModelChoices, type ModelChoice } from './interactive-chat-model.js';
import { createDefaultModelDiscovery, type ModelDiscovery } from './model-discovery.js';
import { loadPricingTable } from './pricing-table-store.js';
import { createCliProviderForSelection } from './provider-factory.js';
import { readGraphFile, validateGraphModelOptions, validateModelProviderSelection } from './run-agent-graph.js';
import {
    buildCodingAgentGraphForSelection,
    resolveGraphSdkModel,
    runCodingPromptOnGraph,
} from './run-agent-graph-prompt.js';
import { runOwnerPrompt } from './run-agent-owner-prompt.js';
import { createRunEventRecorder } from './run-agent-session.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
            const persistedApprovalLevel = await loadPersistedApprovalLevel();
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
                ...(persistedApprovalLevel !== undefined ? { initialApprovalLevel: persistedApprovalLevel } : {}),
                persistApprovalLevel: async (level) => {
                    await savePersistedApprovalLevel(level);
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
            closePersistentStore(persistentStore);
            await closeTreeSitterClient();
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
    const pricingTable = await loadPricingTable();
    const workflowInvocation = resolveWorkflowInvocation(args);
    let effectivePrompt = args.prompt;
    let workflowGraph: AbgGraphSpec | undefined;
    if (workflowInvocation !== undefined) {
        const registry = await discoverWorkflowRegistry(workspaceRoot);
        const spec = registry.lookup(workflowInvocation.name);
        if (spec === undefined) {
            const names = registry.names();
            const available = names.length === 0 ? '(none discovered)' : names.slice(0, 20).join(', ');
            throw new Error(`Unknown workflow "${workflowInvocation.name}". Available workflows: ${available}.`);
        }
        workflowGraph = spec.graph;
        effectivePrompt = workflowInvocation.prompt;
    }
    try {
        await renderer.start(runtime);
        await runtime.start();
        didStart = true;
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
            } else if (effectivePrompt !== undefined) {
                await runCodingPromptOnGraph({
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
        closePersistentStore(persistentStore);
        await closeTreeSitterClient();
    }
    return renderer.getOutput();
}

function shouldRunInteractiveChat(args: CliArgs, graph: AbgGraphSpec | undefined, options: RunAgentOptions): boolean {
    return (
        graph === undefined &&
        args.mode === 'tui' &&
        (options.chatInput !== undefined || (process.stdin.isTTY === true && process.stdout.isTTY === true))
    );
}

const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.:/-]+$/;

type WorkflowInvocation = {
    readonly name: string;
    readonly prompt: string;
};

function resolveWorkflowInvocation(args: CliArgs): WorkflowInvocation | undefined {
    if (args.workflowName !== undefined) {
        return { name: args.workflowName, prompt: args.prompt ?? '' };
    }
    if (args.prompt?.startsWith('#')) {
        const parts = splitCommandParts(args.prompt.slice(1));
        if (parts.head.length === 0) {
            throw new Error('Workflow invocation requires a name after "#"');
        }
        if (!WORKFLOW_NAME_PATTERN.test(parts.head)) {
            throw new Error(`Invalid workflow name: "${parts.head}"`);
        }
        return { name: parts.head, prompt: parts.tail };
    }
    return undefined;
}

async function discoverWorkflowRegistry(workspaceRoot: string): Promise<WorkflowRegistry> {
    const pluginManager = new PluginManager({ workspaceRoot });
    let pluginWorkflowDirs: readonly string[] = [];
    try {
        await pluginManager.initialize();
        pluginWorkflowDirs = pluginManager.getWorkflowDirs();
        for (const diagnostic of pluginManager.getDiagnostics()) {
            process.stderr.write(
                `plugin discovery [${diagnostic.severity}] ${diagnostic.pluginName}: ${diagnostic.message}\n`,
            );
        }
    } catch (error: unknown) {
        process.stderr.write(
            `plugin discovery [warning] skipped: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }

    const result = await discoverWorkflows({
        workspaceRoot,
        ...(pluginWorkflowDirs.length > 0 ? { additionalWorkflowDirs: pluginWorkflowDirs } : {}),
    });
    for (const diagnostic of result.diagnostics) {
        process.stderr.write(
            `workflow discovery [${diagnostic.severity}] ${diagnostic.workflowName}: ${diagnostic.message}\n`,
        );
    }
    const registry = new WorkflowRegistry(result.workflows);
    registerBuiltinWorkflows(registry);
    try {
        await pluginManager.registerInto(registry);
    } catch (error: unknown) {
        process.stderr.write(
            `plugin registration [warning] skipped: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }
    return registry;
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

function closePersistentStore(store: PersistentMemoryStore | undefined): void {
    if (store instanceof TursoPersistentStore) {
        store.close();
    }
}

function createRenderer(mode: CliArgs['mode']): AgentUIRenderer {
    switch (mode) {
        case 'plain':
            return new PlainRenderer();
        case 'json':
        case 'jsonl':
            return new JsonRenderer();
        case 'tui':
            return new TuiRenderer();
        default:
            return assertNever(mode);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unexpected CLI mode: ${String(value)}`);
}

export function detectWorkspaceRoot(): string {
    const cwd = process.cwd();
    let dir = cwd;
    for (let i = 0; i < 20; i++) {
        if (existsSync(join(dir, '.git'))) {
            return dir;
        }
        const pkgPath = join(dir, 'package.json');
        if (existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                if (Array.isArray(pkg.workspaces) || typeof pkg.workspaces === 'object') {
                    return dir;
                }
            } catch {
                // ignore parse errors
            }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return cwd;
}

/**
 * Workspace resolution precedence:
 *   1. `--workspace <path>` flag (`args.workspacePath`)
 *   2. `MCTRL_WORKSPACE` env var (lets tests/scripts pin without flags)
 *   3. `detectWorkspaceRoot()` heuristic (`.git` / workspaces `package.json`)
 *
 * An explicit `--workspace` value must point to an existing directory; failure is hard
 * because silently falling back would hide a typo from the user. Env/heuristic results
 * are trusted as-is to preserve existing behavior.
 */
export function resolveWorkspaceRoot(explicitPath: string | undefined): string {
    if (explicitPath !== undefined) {
        const resolved = resolve(explicitPath);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            throw new Error(`--workspace path does not exist or is not a directory: ${explicitPath}`);
        }
        return resolved;
    }
    const envWorkspace = process.env['MCTRL_WORKSPACE'];
    if (envWorkspace !== undefined && envWorkspace.length > 0) {
        const resolved = resolve(envWorkspace);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            throw new Error(`MCTRL_WORKSPACE path does not exist or is not a directory: ${envWorkspace}`);
        }
        return resolved;
    }
    return detectWorkspaceRoot();
}

async function buildAgentModelLookup(workspaceRoot: string): Promise<AgentModelLookup | undefined> {
    const result = await discoverAgents({
        workspaceRoot,
        userConfigDir: resolveUserConfigDir(),
    });
    const index = new Map<string, AbgNodeModelOptions>();
    for (const agent of result.agents) {
        if (agent.model === undefined || agent.disabled === true) continue;
        const resolved = typeof agent.model === 'string' ? parseAgentModelString(agent.model) : agent.model;
        if (resolved !== undefined) {
            index.set(agent.name, resolved);
        }
    }
    if (index.size === 0) return undefined;
    return (name: string) => index.get(name);
}

function parseAgentModelString(value: string): AbgNodeModelOptions | undefined {
    const sep = value.indexOf('/');
    if (sep <= 0 || sep === value.length - 1) return undefined;
    return { providerID: value.slice(0, sep), modelID: value.slice(sep + 1) };
}
