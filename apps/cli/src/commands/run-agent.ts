import { modelProviderCatalog } from '@mission-control/config';
import { AgentRuntime, type AgentRuntimeOptions } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { type AgentUIRenderer, InkRenderer, JsonRenderer, PlainRenderer } from '../ui/renderers.js';

export type RunAgentOptions = {
    readonly authStore?: ProviderAuthStore;
};

export async function runAgent(args: CliArgs, options: RunAgentOptions = {}): Promise<string> {
    const modelProviderSelection = validateModelProviderSelection(await resolveModelProviderSelection(args, options));
    const runtime = new AgentRuntime(createRuntimeOptions(args.useNative, modelProviderSelection));
    const renderer = createRenderer(args.mode);
    await renderer.start(runtime);
    const unsubscribe = runtime.onEvent((event) => {
        renderer.render(event);
    });
    await runtime.start();
    await runtime.runDemoTask();
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
