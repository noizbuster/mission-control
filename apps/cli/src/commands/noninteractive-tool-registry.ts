import {
    type BrowserConnectFn,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createNativesClient,
    createReadOnlyRepoToolRegistrations,
    discoverSkills,
    type EvalContextManagerFactory,
    type LspClient,
    type LspServerManagerDeps,
    type McpConnectionManager,
    type ProjectTrustReader,
    ProjectTrustStore,
    type ProviderAuthStore,
    registerAskUserTool,
    registerAstGrepTool,
    registerBashRunTool,
    registerCommandRunTool,
    registerConfiguredBrowserTool,
    registerEvalTool,
    registerFileEditTool,
    registerFilePatchTool,
    registerFileWriteTool,
    registerFullParityTaskTool,
    registerGlobTool,
    registerNamespacedMcpTools,
    registerSkillTool,
    registerWebfetchTool,
    registerWebSearchTool,
    registerWorkflowTool,
    type SdkModelResolver,
    selectWebSearchProvider,
    type TaskToolRuntimeServices,
    ToolRegistry,
    todoWriteToolRegistration,
    type WorkflowRegistry,
    wireNativesFsCacheInvalidator,
} from '@mission-control/core';
import type {
    AbgNodeModelOptions,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    WorkflowSpec,
} from '@mission-control/protocol';
import { readModelPatternOverrides } from './agents-model-overrides-config.js';
import { cliAllowsAction } from './cli-permission-policy.js';
import { createGraphObservabilityRedactor } from './graph-observability-redactor.js';
import { registerAvailableLspTool } from './lsp-tool-registration.js';
import { buildRoleConfigFromAuth } from './model-role-config.js';
import { completeProductionToolSetup, type ProductionToolRegistry } from './production-tool-registry.js';

type NonInteractiveToolRegistryOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly enableTrustedBash?: boolean;
    readonly evalContextManagerFactory?: EvalContextManagerFactory;
    readonly projectTrustStore?: ProjectTrustReader;
    /**
     * When provided alongside `modelProviderSelection`, the full-parity `task` tool is registered
     * with a `ConcreteTaskToolRuntime`; its `buildChildToolSurface` authority step filters this
     * registry and installs invocation-time child policy checks. Omit when the model resolver is
     * unavailable (the `task` tool is simply absent from the registry — no mock/fallback).
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
     * LSP seam: when a real `LspClient` is injected, the `lsp` tool is registered
     * with that client (test injection path). When omitted, the registry
     * auto-detects available language servers via `LspServerManager` and registers
     * the `lsp` tool with a delegating client when at least one server command
     * resolves on PATH.
     */
    readonly lspClient?: LspClient;
    /**
     * Test seam for the auto-detection path: inject a mock `commandExists` /
     * `createClient` so tests control server availability without spawning real
     * processes. Ignored when `lspClient` is explicitly provided.
     */
    readonly lspServerManagerDeps?: LspServerManagerDeps;
    readonly authStore?: ProviderAuthStore;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly onWorkflowStarted?: (spec: WorkflowSpec, prompt: string) => void;
    readonly services?: TaskToolRuntimeServices;
    readonly profileName?: string;
    readonly browserConnect?: BrowserConnectFn;
};

export async function createNonInteractiveToolRegistry(
    options: NonInteractiveToolRegistryOptions,
): Promise<ProductionToolRegistry> {
    const registry = new ToolRegistry();
    const projectTrustStore = options.projectTrustStore ?? new ProjectTrustStore();
    // One shared natives client backs the read/search tools and the fs scan
    // cache invalidation hook: file mutations (edit/write/patch) clear the
    // cache so the next grep/read serves fresh content.
    const natives = createNativesClient({ onWarning: () => {} });
    wireNativesFsCacheInvalidator(natives);
    const readTools = await createReadOnlyRepoToolRegistrations({
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        natives,
    });
    registry.register(readTools[0]);
    registry.register(readTools[1]);
    registry.register(readTools[2]);
    registry.register(readTools[7]);
    await registerGlobTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerAstGrepTool(registry, { workspaceRoot: options.workspaceRoot });
    registry.register(todoWriteToolRegistration);
    const skillDiscovery = await discoverSkills({ workspaceRoot: options.workspaceRoot });
    registerSkillTool(registry, { skills: skillDiscovery.skills });
    if (options.workflowRegistry !== undefined) {
        registerWorkflowTool(registry, {
            registry: options.workflowRegistry,
            ...(options.onWorkflowStarted !== undefined ? { onWorkflowStarted: options.onWorkflowStarted } : {}),
        });
    }
    await registerWebfetchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    if (selectWebSearchProvider() !== undefined) {
        await registerWebSearchTool(registry, {
            sessionId: options.sessionId ?? 'default',
            ...(natives.available ? { natives } : {}),
        });
    }
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
        await registerEvalTool(registry, {
            workspaceRoot: options.workspaceRoot,
            projectTrustStore,
            requestPermission: options.requestPermission,
            ...(options.evalContextManagerFactory !== undefined
                ? { contextManagerFactory: options.evalContextManagerFactory }
                : {}),
        });
    }
    const mcpConnectionManager = await registerNamespacedMcpTools(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        ...(options.mcpConnectionManager !== undefined ? { mcpConnectionManager: options.mcpConnectionManager } : {}),
        ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
    });
    return completeProductionToolSetup(
        { registry, mcpConnectionManager },
        options.mcpConnectionManager === undefined,
        async () => {
            const browserTool = await registerConfiguredBrowserTool(registry, {
                workspaceRoot: options.workspaceRoot,
                projectTrustStore,
                requestPermission: options.requestPermission,
                ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
                ...(options.browserConnect !== undefined ? { connect: options.browserConnect } : {}),
            });
            const observabilityRedactor = await createGraphObservabilityRedactor({
                mcpConnectionManager,
                ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
            });
            const resolveSdkModel = options.resolveSdkModel;
            const selection = options.modelProviderSelection;
            if (resolveSdkModel !== undefined && selection !== undefined) {
                const model: AbgNodeModelOptions = {
                    providerID: selection.providerID,
                    modelID: selection.modelID,
                    ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
                };
                const agentModelOverrides = await readModelPatternOverrides({ workspaceRoot: options.workspaceRoot });
                const roleConfig =
                    options.authStore !== undefined ? await buildRoleConfigFromAuth(options.authStore) : undefined;
                await registerFullParityTaskTool(registry, {
                    workspaceRoot: options.workspaceRoot,
                    requestPermission: options.requestPermission,
                    resolveSdkModel,
                    model,
                    parentToolRegistry: registry,
                    agentModelOverrides,
                    ...(roleConfig !== undefined ? { roleConfig } : {}),
                    ...(options.sessionId !== undefined ? { parentSessionId: options.sessionId } : {}),
                    ...(options.services !== undefined ? { services: options.services } : {}),
                    hostCallbacks: { observabilityRedactor },
                });
            }
            await registerAvailableLspTool(
                registry,
                options.workspaceRoot,
                options.lspClient,
                options.lspServerManagerDeps,
            );
            return browserTool;
        },
        'noninteractive',
    );
}
