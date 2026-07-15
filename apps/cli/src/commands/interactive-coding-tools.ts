import {
    type AskUserQuestionRequest,
    type BrowserConnectFn,
    type ChildHostCallbacks,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createNativesClient,
    createReadOnlyRepoToolRegistrations,
    discoverSkills,
    type EvalContextManagerFactory,
    type LspClient,
    type LspServerManagerDeps,
    type McpConnectionManager,
    type ObservabilityRedactor,
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
import type { AbgNodeModelOptions, AgentEvent, ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import type { ApprovalLevel } from '@mission-control/tui/state';
import { readModelPatternOverrides } from './agents-model-overrides-config';
import { cliAllowsAction } from './cli-permission-policy';
import type { InteractiveApprovalBroker } from './interactive-approval-broker';
import type { ChatOutput } from './interactive-chat-io';
import { registerAvailableLspTool } from './lsp-tool-registration';
import { buildRoleConfigFromAuth } from './model-role-config';
import { completeProductionToolSetup, type ProductionToolRegistry } from './production-tool-registry';

export type InteractiveToolOptions = {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly enableTrustedBash?: boolean;
    readonly evalContextManagerFactory?: EvalContextManagerFactory;
    readonly projectTrustStore?: ProjectTrustReader;
    /**
     * When set, the `task` subagent tool is registered with a real spawn closure built from
     * `spawnChildCodingAgent` (the child surface derives from THIS registry). Omit to leave the
     * `task` tool absent (no mock/fallback).
     */
    readonly resolveSdkModel?: SdkModelResolver;
    /**
     * An already-connected MCP connection manager to reuse across turns (session-scoped).
     * When omitted, the factory creates a new manager and connects eagerly.
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
    /**
     * `ask_user` tool callback: resolves with the user's answer to a model-posed question. When
     * omitted, the `ask_user` tool is not registered (no host surface to ask the user). The
     * interactive TUI wires this to the question overlay.
     */
    readonly requestUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
    /**
     * Optional batch variant: hands the whole `questions` array to the host in
     * one call so it can render a single tabbed overlay (opencode-style) with a
     * confirm step. Returns one answer string per request, in order. When
     * omitted the tool falls back to sequential single-question prompts.
     */
    readonly requestUserQuestions?: (requests: readonly AskUserQuestionRequest[]) => Promise<string[]>;
    readonly approvalLevel?: ApprovalLevel;
    readonly authStore?: ProviderAuthStore;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly onWorkflowStarted?: (spec: WorkflowSpec, prompt: string) => void;
    readonly services?: TaskToolRuntimeServices;
    readonly profileName?: string;
    /**
     * Lazy holder for routing child ask_user overlays and graph events back into this TUI.
     * `requestUserQuestion(s)` / `emitEvent` / `output` are populated up front; `onSignal`
     * and `onDurableEvent` are assigned after those handlers are constructed (later in the
     * same turn-setup path). The task tool closure reads these at SPAWN time, so the late
     * assignment is safe.
     */
    readonly childHostCallbacks?: ChildHostCallbacks;
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly browserConnect?: BrowserConnectFn;
};

export { preflightInteractiveToolCall } from './interactive-coding-tool-approval';

export async function createInteractiveToolRegistry(
    options: InteractiveToolOptions,
    approvals: InteractiveApprovalBroker,
): Promise<ProductionToolRegistry> {
    const registry = new ToolRegistry();
    // One shared natives client backs the read/search tools and the fs scan
    // cache invalidation hook: file mutations (edit/write/patch) clear the
    // cache so the next grep/read serves fresh content.
    const natives = createNativesClient({ onWarning: () => {} });
    wireNativesFsCacheInvalidator(natives);
    const readTools = await createReadOnlyRepoToolRegistrations({
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
        natives,
    });
    registry.register(readTools[3]);
    registry.register(readTools[4]);
    registry.register(readTools[5]);
    registry.register(readTools[6]);
    registry.register(readTools[7]);
    await registerGlobTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
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
        requestPermission: approvals.requestPermission,
    });
    if (selectWebSearchProvider() !== undefined) {
        await registerWebSearchTool(registry, {
            sessionId: options.sessionId,
            ...(natives.available ? { natives } : {}),
        });
    }
    if (options.requestUserQuestion !== undefined) {
        await registerAskUserTool(registry, {
            requestUserQuestion: options.requestUserQuestion,
            ...(options.requestUserQuestions !== undefined
                ? { requestUserQuestions: options.requestUserQuestions }
                : {}),
        });
    }
    await registerFileEditTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerFileWriteTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerFilePatchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    if (options.enableTrustedBash === true && cliAllowsAction('bash.run')) {
        await registerBashRunTool(registry, {
            workspaceRoot: options.workspaceRoot,
            workspaceTrust: 'trusted',
            requestPermission: approvals.requestPermission,
            ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
        });
        await registerEvalTool(registry, {
            workspaceRoot: options.workspaceRoot,
            projectTrustStore: options.projectTrustStore ?? new ProjectTrustStore(),
            requestPermission: approvals.requestPermission,
            ...(options.evalContextManagerFactory !== undefined
                ? { contextManagerFactory: options.evalContextManagerFactory }
                : {}),
        });
    }
    const resolveSdkModel = options.resolveSdkModel;
    if (resolveSdkModel !== undefined) {
        const selection = options.modelProviderSelection;
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
            requestPermission: approvals.requestPermission,
            resolveSdkModel,
            model,
            parentToolRegistry: registry,
            parentSessionId: options.sessionId,
            agentModelOverrides,
            ...(roleConfig !== undefined ? { roleConfig } : {}),
            ...(options.services !== undefined ? { services: options.services } : {}),
            ...(options.childHostCallbacks !== undefined ? { hostCallbacks: options.childHostCallbacks } : {}),
        });
    }
    const mcpConnectionManager = await registerNamespacedMcpTools(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
        ...(options.mcpConnectionManager !== undefined ? { mcpConnectionManager: options.mcpConnectionManager } : {}),
        ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
    });
    return completeProductionToolSetup(
        { registry, mcpConnectionManager },
        options.mcpConnectionManager === undefined,
        async () => {
            const browserTool = await registerConfiguredBrowserTool(registry, {
                workspaceRoot: options.workspaceRoot,
                projectTrustStore: options.projectTrustStore ?? new ProjectTrustStore(),
                requestPermission: approvals.requestPermission,
                ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
                ...(options.browserConnect !== undefined ? { connect: options.browserConnect } : {}),
            });
            await registerAvailableLspTool(
                registry,
                options.workspaceRoot,
                options.lspClient,
                options.lspServerManagerDeps,
            );
            return browserTool;
        },
        'interactive',
    );
}
