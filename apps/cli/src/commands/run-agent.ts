import { defaultModelProviderSelection, modelProviderCatalog } from '@mission-control/config';
import { AgentRuntime, type AgentRuntimeOptions } from '@mission-control/core';
import {
    type AbgGraphSpec,
    AbgGraphSpecSchema,
    type AbgNodeModelOptions,
    type AgentEvent,
    type ModelProviderSelection,
} from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { type AgentUIRenderer, InkRenderer, JsonRenderer, PlainRenderer } from '../ui/renderers.js';
import { type ChatInput, type ChatOutput, type ModelSelector, runInteractiveChatSession } from './interactive-chat.js';
import { createModelChoices, type ModelChoice } from './interactive-chat-model.js';
import { createDefaultModelDiscovery, type ModelDiscovery } from './model-discovery.js';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export type RunAgentOptions = {
    readonly authStore?: ProviderAuthStore;
    readonly chatInput?: ChatInput;
    readonly chatOutput?: ChatOutput;
    readonly selectModel?: ModelSelector;
    readonly modelDiscovery?: ModelDiscovery;
    readonly onRuntimeEvent?: (event: AgentEvent) => void;
};

export async function runAgent(args: CliArgs, options: RunAgentOptions = {}): Promise<string> {
    const authStore = options.authStore ?? createProviderAuthStore();
    const modelProviderSelection = validateModelProviderSelection(await resolveModelProviderSelection(args, authStore));
    const graph = args.graphPath !== undefined ? await readGraphFile(args.graphPath) : undefined;
    if (graph !== undefined) {
        validateGraphModelOptions(graph);
    }
    const runtime = new AgentRuntime(createRuntimeOptions(args.useNative, modelProviderSelection));
    if (shouldRunInteractiveChat(args, graph, options)) {
        const unsubscribeRuntimeEvents =
            options.onRuntimeEvent === undefined ? undefined : runtime.onEvent(options.onRuntimeEvent);
        let didStart = false;
        try {
            await runtime.start();
            didStart = true;
            return await runInteractiveChatSession(runtime, {
                modelProviderSelection: modelProviderSelection ?? defaultModelProviderSelection,
                modelChoices: await listAuthenticatedModelChoices(
                    authStore,
                    options.modelDiscovery ?? createDefaultModelDiscovery(),
                ),
                ...(options.chatInput !== undefined ? { input: options.chatInput } : {}),
                ...(options.chatOutput !== undefined ? { output: options.chatOutput } : {}),
                ...(options.selectModel !== undefined ? { selectModel: options.selectModel } : {}),
            });
        } finally {
            if (didStart) {
                await runtime.stop();
            }
            unsubscribeRuntimeEvents?.();
        }
    }

    const renderer = createRenderer(args.mode);
    await renderer.start(runtime);
    const unsubscribe = runtime.onEvent((event) => {
        renderer.render(event);
    });
    await runtime.start();
    if (graph === undefined) {
        await runtime.runDemoTask();
    } else {
        await runtime.runGraph(graph);
    }
    unsubscribe();
    await renderer.stop();
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
    const baseChoices = createModelChoices({ providerIDs });
    const choices: ModelChoice[] = [];

    for (const providerID of providerIDs) {
        const provider = modelProviderCatalog.find((entry) => entry.id === providerID);
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
        const discoveredModelIDSet = new Set(discoveredModelIDs);
        choices.push(...providerChoices.filter((choice) => discoveredModelIDSet.has(choice.selection.modelID)));
    }

    return choices;
}

function createRuntimeOptions(
    useNative: boolean | undefined,
    modelProviderSelection: ModelProviderSelection | undefined,
): AgentRuntimeOptions {
    if (useNative === undefined) {
        if (modelProviderSelection === undefined) {
            return {};
        }
        return { modelProviderSelection };
    }
    if (modelProviderSelection === undefined) {
        return { useNative };
    }
    return { useNative, modelProviderSelection };
}

function validateModelProviderSelection(
    modelProviderSelection: ModelProviderSelection | undefined,
): ModelProviderSelection | undefined {
    if (modelProviderSelection === undefined) {
        return undefined;
    }
    const provider = modelProviderCatalog.find((entry) => entry.id === modelProviderSelection.providerID);
    if (provider === undefined) {
        throw new Error(`Unknown provider: ${modelProviderSelection.providerID}`);
    }
    if (!provider.models.some((model) => model.id === modelProviderSelection.modelID)) {
        throw new Error(
            `Model ${modelProviderSelection.modelID} is not available for provider ${modelProviderSelection.providerID}`,
        );
    }
    return modelProviderSelection;
}

async function readGraphFile(graphPath: string): Promise<AbgGraphSpec> {
    const raw = await readFirstGraphPath(graphPath);
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(raw);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            throw new Error(`Invalid graph JSON ${graphPath}: ${error.message}`);
        }
        throw error;
    }
    const parsed = AbgGraphSpecSchema.safeParse(parsedJson);
    if (!parsed.success) {
        throw new Error(
            `Invalid graph file ${graphPath}: ${parsed.error.issues[0]?.message ?? 'invalid ABG graph spec'}`,
        );
    }
    return parsed.data;
}

async function readFirstGraphPath(graphPath: string): Promise<string> {
    let missingPath: string | undefined;
    for (const candidate of resolveGraphPathCandidates(graphPath)) {
        try {
            return await readFile(candidate, 'utf8');
        } catch (error: unknown) {
            if (isMissingFileError(error)) {
                missingPath = candidate;
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Graph file not found: ${missingPath ?? graphPath}`);
}

function resolveGraphPathCandidates(graphPath: string): readonly string[] {
    if (isAbsolute(graphPath)) {
        return [graphPath];
    }
    const { INIT_CWD: invocationCwd } = process.env;
    const bases = [
        ...(invocationCwd !== undefined && invocationCwd.length > 0 ? [invocationCwd] : []),
        process.cwd(),
        resolve(process.cwd(), '../..'),
    ];
    return [...new Set(bases.map((base) => resolve(base, graphPath)))];
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}

function validateGraphModelOptions(graph: AbgGraphSpec): void {
    if (graph.defaults?.model !== undefined) {
        validateNodeModelOptions(graph.defaults.model);
    }
    for (const node of graph.nodes) {
        if (node.model !== undefined) {
            validateNodeModelOptions(node.model);
        }
    }
}

function validateNodeModelOptions(model: AbgNodeModelOptions): void {
    const provider = modelProviderCatalog.find((entry) => entry.id === model.providerID);
    if (provider === undefined) {
        throw new Error(`Unknown provider: ${model.providerID}`);
    }
    const modelEntry = provider.models.find((entry) => entry.id === model.modelID);
    if (modelEntry === undefined) {
        throw new Error(`Model ${model.modelID} is not available for provider ${model.providerID}`);
    }
    if (
        model.variantID !== undefined &&
        modelEntry.variants?.some((variant) => variant.id === model.variantID) !== true
    ) {
        throw new Error(`Variant ${model.variantID} is not available for model ${model.providerID}/${model.modelID}`);
    }
    for (const fallback of model.fallbacks ?? []) {
        validateNodeModelOptions(fallback);
    }
}

function createRenderer(mode: CliArgs['mode']): AgentUIRenderer {
    switch (mode) {
        case 'plain':
            return new PlainRenderer();
        case 'json':
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
