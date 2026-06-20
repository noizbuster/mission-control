import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createLspToolRegistration,
    createReadOnlyRepoToolRegistrations,
    createTaskSpawnFn,
    discoverSkills,
    type LspClient,
    McpConnectionManager,
    registerAskUserTool,
    registerBashRunTool,
    registerCommandRunTool,
    registerFileEditTool,
    registerFilePatchTool,
    registerFileWriteTool,
    registerGlobTool,
    registerNamespacedMcpTools,
    registerSkillTool,
    registerTaskTool,
    registerWebfetchTool,
    type SdkModelResolver,
    ToolRegistry,
    type ToolRegistryWithMcp,
    todoWriteToolRegistration,
} from '@mission-control/core';
import type {
    AbgNodeModelOptions,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import { cliAllowsAction } from './cli-permission-policy.js';

type NonInteractiveToolRegistryOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly enableTrustedBash?: boolean;
    /**
     * When provided alongside `modelProviderSelection`, the `task` subagent tool is registered
     * with a real spawn closure built from `spawnChildCodingAgent` (the child surface derives from
     * THIS registry via `createChildToolRegistry`). Omit when the model resolver is unavailable
     * (the `task` tool is simply absent from the registry — no mock/fallback).
     */
    readonly resolveSdkModel?: SdkModelResolver;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly sessionId?: string;
    /**
     * An already-connected MCP connection manager to reuse. When omitted, the factory creates
     * a new manager and connects eagerly.
     */
    readonly mcpConnectionManager?: McpConnectionManager;
    /**
     * LSP seam: when a real `LspClient` is injected, the `lsp` tool is registered (read-class,
     * opt-in). Default runs omit it; a real stdio JSON-RPC language-server transport is deferred.
     */
    readonly lspClient?: LspClient;
};

export async function createNonInteractiveToolRegistry(
    options: NonInteractiveToolRegistryOptions,
): Promise<ToolRegistryWithMcp> {
    const registry = new ToolRegistry();
    const readTools = await createReadOnlyRepoToolRegistrations({
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    registry.register(readTools[0]);
    registry.register(readTools[1]);
    registry.register(readTools[2]);
    await registerGlobTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    registry.register(todoWriteToolRegistration);
    const skillDiscovery = await discoverSkills({ workspaceRoot: options.workspaceRoot });
    registerSkillTool(registry, { skills: skillDiscovery.skills });
    await registerWebfetchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    // Non-interactive runs have no TUI to ask the user, so ask_user resolves with an empty
    // answer (the documented non-TTY degradation) instead of hanging.
    await registerAskUserTool(registry, { requestUserQuestion: () => Promise.resolve('') });
    await registerFileEditTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerFileWriteTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerFilePatchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    if (options.enableTrustedBash === true && cliAllowsAction('bash.run')) {
        await registerBashRunTool(registry, {
            workspaceRoot: options.workspaceRoot,
            workspaceTrust: 'trusted',
            requestPermission: options.requestPermission,
            ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
        });
    }
    const resolveSdkModel = options.resolveSdkModel;
    const selection = options.modelProviderSelection;
    if (resolveSdkModel !== undefined && selection !== undefined) {
        const model: AbgNodeModelOptions = {
            providerID: selection.providerID,
            modelID: selection.modelID,
            ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
        };
        await registerTaskTool(registry, {
            workspaceRoot: options.workspaceRoot,
            requestPermission: options.requestPermission,
            spawn: createTaskSpawnFn({
                resolveSdkModel,
                model,
                parentToolRegistry: registry,
                ...(options.sessionId !== undefined ? { parentSessionId: options.sessionId } : {}),
            }),
        });
    }
    const mcpConnectionManager = await registerNamespacedMcpTools(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        ...(options.mcpConnectionManager !== undefined ? { mcpConnectionManager: options.mcpConnectionManager } : {}),
    });
    // LSP seam: register `lsp` ONLY when a real client is injected. Default runs (no client)
    // do not advertise it — a real stdio JSON-RPC language-server transport is deferred.
    if (options.lspClient !== undefined) {
        registry.register(
            createLspToolRegistration({
                client: options.lspClient,
                guideline:
                    'Use lsp for compiler-grade diagnostics, hover, and go-to-definition ' +
                    'instead of guessing types from source text.',
            }),
        );
    }
    return { registry, mcpConnectionManager };
}
