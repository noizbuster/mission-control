import { defaultModelProviderSelection, modelProviderCatalog } from '@mission-control/config';
import {
    type AbgGraphSpec,
    AbgGraphSpecSchema,
    type AbgNodeModelOptions,
    type ModelProviderSelection,
} from '@mission-control/protocol';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export async function readGraphFile(graphPath: string): Promise<AbgGraphSpec> {
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

export function validateGraphModelOptions(graph: AbgGraphSpec): void {
    if (graph.defaults?.model !== undefined) {
        validateNodeModelOptions(graph.defaults.model);
    }
    for (const node of graph.nodes) {
        if (node.model !== undefined) {
            validateNodeModelOptions(node.model);
        }
    }
}

export function validateModelProviderSelection(
    modelProviderSelection: ModelProviderSelection | undefined,
): ModelProviderSelection | undefined {
    if (modelProviderSelection === undefined) {
        return undefined;
    }
    validateNodeModelOptions(modelProviderSelection);
    return modelProviderSelection;
}

export function effectiveModelProviderSelection(selection: ModelProviderSelection | undefined): ModelProviderSelection {
    return selection ?? defaultModelProviderSelection;
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

function validateNodeModelOptions(model: AbgNodeModelOptions): void {
    const provider = modelProviderCatalog.find((entry) => entry.id === model.providerID);
    if (provider === undefined) {
        throw new Error(`Unknown provider: ${model.providerID}`);
    }
    const modelEntry = provider.models.find((entry) => entry.id === model.modelID);
    if (modelEntry === undefined) {
        throw new Error(`Model ${model.modelID} is not available for provider ${model.providerID}`);
    }
    if (model.variantID !== undefined) {
        const variantExists = (modelEntry.variants ?? []).some((variant) => variant.id === model.variantID);
        if (!variantExists) {
            throw new Error(`Variant ${model.variantID} is not available for model ${model.providerID}/${model.modelID}`);
        }
    }
    for (const fallback of model.fallbacks ?? []) {
        validateNodeModelOptions(fallback);
    }
}
