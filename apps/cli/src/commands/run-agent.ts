import { defaultModelProviderSelection } from '@mission-control/config';
import {
    AgentRuntime,
    createNativesClient,
    createPersistentStore,
    createProviderAuthStoreObservabilityRedactor,
    loadResolvedMcpConfig,
    reconcileCrashedSessions,
    resolveMissionControlDataDir,
} from '@mission-control/core';
import type { CliArgs, CliSessionDebugIntent } from '../args';
import { createProviderAuthStore } from '../auth-store';
import { createCliRuntimeOptions } from './cli-runtime-options';
import { createCliProviderForSelection } from './provider-factory';
import { readGraphFile, validateGraphModelOptions, validateModelProviderSelection } from './run-agent-graph';
import { shouldRunInteractiveChat } from './run-agent-mode';
import { buildAgentModelLookup, resolveModelProviderSelection } from './run-agent-model-selection';
import { runNoninteractiveAgent } from './run-agent-noninteractive';
import type { RunAgentOptions } from './run-agent-options';
import { resolveRunSessionDebugConfig } from './run-agent-session-debug';
import { resolveWorkspaceRoot } from './run-agent-workspace';

export { createCliProviderForSelection } from './provider-factory';
export type { RunAgentOptions } from './run-agent-options';
export {
    resolveWorkflowInvocation,
    type WorkflowInvocation,
    type WorkflowInvocationInput,
} from './run-agent-workflow';
export { detectWorkspaceRoot, resolveWorkspaceRoot } from './run-agent-workspace';

export async function runAgent(
    args: CliArgs,
    options: RunAgentOptions = {},
    _sessionDebugIntent: CliSessionDebugIntent | undefined = undefined,
): Promise<string> {
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
    const resolvedMcpConfig = await loadResolvedMcpConfig({
        workspaceRoot,
        ...(args.profileName !== undefined ? { profileName: args.profileName } : {}),
    });
    const config = resolvedMcpConfig.config;
    const sessionDebugConfig = resolveRunSessionDebugConfig(resolvedMcpConfig.sessionDebugConfig, _sessionDebugIntent);
    const agentModelLookup = await buildAgentModelLookup(workspaceRoot);
    const dataDir = resolveMissionControlDataDir();
    const persistentStore = await createPersistentStore(dataDir);
    if (persistentStore !== undefined) {
        await reconcileCrashedSessions({ dataDir });
    }
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
            ...(sessionDebugConfig.enabled
                ? {
                      sessionDebug: {
                          config: sessionDebugConfig,
                          dataDir,
                          natives: createNativesClient({ onWarning: () => {} }),
                      },
                  }
                : {}),
        }),
    );
    if (shouldRunChat) {
        const { runInteractiveAgent } = await import('./run-agent-interactive');
        return await runInteractiveAgent({
            args,
            runtime,
            authStore,
            provider,
            selectedModelProvider,
            createProvider,
            workspaceRoot,
            config,
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
        config,
        observabilityRedactor,
        ...(graph !== undefined ? { graph } : {}),
        ...(agentModelLookup !== undefined ? { agentModelLookup } : {}),
        ...(persistentStore !== undefined ? { persistentStore } : {}),
    });
}
