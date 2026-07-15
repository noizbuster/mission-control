import { defaultModelProviderSelection } from '@mission-control/config';
import {
    AgentRuntime,
    createPersistentStore,
    createProviderAuthStoreObservabilityRedactor,
    resolveMissionControlDataDir,
} from '@mission-control/core';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { createCliRuntimeOptions } from './cli-runtime-options.js';
import { createCliProviderForSelection } from './provider-factory.js';
import { readGraphFile, validateGraphModelOptions, validateModelProviderSelection } from './run-agent-graph.js';
import { shouldRunInteractiveChat } from './run-agent-mode.js';
import { buildAgentModelLookup, resolveModelProviderSelection } from './run-agent-model-selection.js';
import { runNoninteractiveAgent } from './run-agent-noninteractive.js';
import type { RunAgentOptions } from './run-agent-options.js';
import { resolveWorkspaceRoot } from './run-agent-workspace.js';

export { createCliProviderForSelection } from './provider-factory.js';
export {
    resolveWorkflowInvocation,
    type WorkflowInvocation,
    type WorkflowInvocationInput,
} from './run-agent-workflow.js';
export { detectWorkspaceRoot, resolveWorkspaceRoot } from './run-agent-workspace.js';
export type { RunAgentOptions } from './run-agent-options.js';

export async function runAgent(args: CliArgs, options: RunAgentOptions = {}): Promise<string> {
    const authStore = options.authStore ?? createProviderAuthStore();
    const modelProviderSelection = validateModelProviderSelection(await resolveModelProviderSelection(args, authStore));
    const graph = args.graphPath !== undefined ? await readGraphFile(args.graphPath) : undefined;
    if (graph !== undefined) {
        validateGraphModelOptions(graph);
    }
    const selectedModelProvider = modelProviderSelection ?? defaultModelProviderSelection;
    const shouldRunChat = shouldRunInteractiveChat(args, graph, options.chatInput !== undefined);
    const createProvider =
        options.createProvider ?? ((selection) => createCliProviderForSelection(selection, authStore));
    const provider = options.provider ?? createProvider(selectedModelProvider);
    const workspaceRoot = options.workspaceRoot ?? resolveWorkspaceRoot(args.workspacePath);
    const agentModelLookup = await buildAgentModelLookup(workspaceRoot);
    const persistentStore = await createPersistentStore(resolveMissionControlDataDir());
    const observabilityRedactor = await createProviderAuthStoreObservabilityRedactor(authStore);
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
            observabilityRedactor,
        }),
    );
    if (shouldRunChat) {
        const { runInteractiveAgent } = await import('./run-agent-interactive.js');
        return await runInteractiveAgent({
            args,
            runtime,
            authStore,
            provider,
            selectedModelProvider,
            createProvider,
            workspaceRoot,
            observabilityRedactor,
            ...(persistentStore !== undefined ? { persistentStore } : { persistentStore: undefined }),
            options,
        });
    }

    return runNoninteractiveAgent({
        args,
        options,
        runtime,
        authStore,
        provider,
        selectedModelProvider,
        workspaceRoot,
        observabilityRedactor,
        ...(graph !== undefined ? { graph } : {}),
        ...(agentModelLookup !== undefined ? { agentModelLookup } : {}),
        ...(persistentStore !== undefined ? { persistentStore } : {}),
    });
}
