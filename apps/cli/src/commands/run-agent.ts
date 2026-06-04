import { modelProviderCatalog } from '@mission-control/config';
import { AgentRuntime, type AgentRuntimeOptions } from '@mission-control/core';
import {
    type AbgGraphSpec,
    AbgGraphSpecSchema,
    type AbgNodeModelOptions,
    type ModelProviderSelection,
} from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { type AgentUIRenderer, InkRenderer, JsonRenderer, PlainRenderer } from '../ui/renderers.js';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export type RunAgentOptions = {
    readonly authStore?: ProviderAuthStore;
};

export async function runAgent(args: CliArgs, options: RunAgentOptions = {}): Promise<string> {
    const modelProviderSelection = validateModelProviderSelection(await resolveModelProviderSelection(args, options));
    const graph = args.graphPath !== undefined ? await readGraphFile(args.graphPath) : undefined;
    if (graph !== undefined) {
        validateGraphModelOptions(graph);
    }
    const runtime = new AgentRuntime(createRuntimeOptions(args.useNative, modelProviderSelection));
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

async function resolveModelProviderSelection(
    args: CliArgs,
    options: RunAgentOptions,
): Promise<ModelProviderSelection | undefined> {
    if (args.modelProviderSelection !== undefined) {
        return args.modelProviderSelection;
    }
    const store = options.authStore ?? createProviderAuthStore();
    return store.getDefaultSelection();
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
