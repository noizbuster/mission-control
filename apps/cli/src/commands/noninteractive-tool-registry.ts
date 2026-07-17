import {
    type BrowserConnectFn,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createNativesClient,
    type EvalContextManagerFactory,
    type LspClient,
    type LspServerManagerDeps,
    type McpConnectionManager,
    type ProjectTrustReader,
    type ProviderAuthStore,
    type SdkModelResolver,
    type SessionToolsOptions,
    type TaskToolRuntimeServices,
    type WorkflowRegistry,
} from '@mission-control/core';
import type {
    MissionControlConfig,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    WorkflowSpec,
} from '@mission-control/protocol';
import type { ProductionToolRegistry } from './production-tool-registry';
import { type ParentMiscToolHostOptions, registerDefaultCodingTools } from './register-default-coding-tools';

type NonInteractiveToolRegistryOptions = ParentMiscToolHostOptions & {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly enableTrustedBash?: boolean;
    readonly tmuxAvailable?: boolean;
    readonly ghAvailable?: () => boolean;
    readonly evalContextManagerFactory?: EvalContextManagerFactory;
    readonly projectTrustStore?: ProjectTrustReader;
    readonly resolveSdkModel?: SdkModelResolver;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly sessionId?: string;
    readonly mcpConnectionManager?: McpConnectionManager;
    readonly lspClient?: LspClient;
    readonly lspServerManagerDeps?: LspServerManagerDeps;
    readonly authStore?: ProviderAuthStore;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly onWorkflowStarted?: (spec: WorkflowSpec, prompt: string) => void;
    readonly services?: TaskToolRuntimeServices;
    readonly sessionTools?: SessionToolsOptions;
    readonly profileName?: string;
    readonly browserConnect?: BrowserConnectFn;
    readonly config?: MissionControlConfig;
};

export async function createNonInteractiveToolRegistry(
    options: NonInteractiveToolRegistryOptions,
): Promise<ProductionToolRegistry> {
    const natives = createNativesClient({ onWarning: () => {} });
    return registerDefaultCodingTools({
        hostKind: 'noninteractive',
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        natives,
        enableTrustedBash: options.enableTrustedBash === true,
        ...(options.tmuxAvailable !== undefined ? { tmuxAvailable: options.tmuxAvailable } : {}),
        ...(options.ghAvailable !== undefined ? { ghAvailable: options.ghAvailable } : {}),
        config: options.config ?? {},
        ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
        ...(options.evalContextManagerFactory !== undefined
            ? { evalContextManagerFactory: options.evalContextManagerFactory }
            : {}),
        ...(options.projectTrustStore !== undefined ? { projectTrustStore: options.projectTrustStore } : {}),
        ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
        ...(options.modelProviderSelection !== undefined
            ? { modelProviderSelection: options.modelProviderSelection }
            : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.mcpConnectionManager !== undefined ? { mcpConnectionManager: options.mcpConnectionManager } : {}),
        ...(options.lspClient !== undefined ? { lspClient: options.lspClient } : {}),
        ...(options.lspServerManagerDeps !== undefined ? { lspServerManagerDeps: options.lspServerManagerDeps } : {}),
        ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
        ...(options.workflowRegistry !== undefined ? { workflowRegistry: options.workflowRegistry } : {}),
        ...(options.onWorkflowStarted !== undefined ? { onWorkflowStarted: options.onWorkflowStarted } : {}),
        ...(options.goalRuntime !== undefined ? { goalRuntime: options.goalRuntime } : {}),
        ...(options.reportToolIssueSink !== undefined ? { reportToolIssueSink: options.reportToolIssueSink } : {}),
        ...(options.reportFinding !== undefined ? { reportFinding: options.reportFinding } : {}),
        ...(options.services !== undefined
            ? { services: options.services, asyncJobManager: options.services.jobManager }
            : {}),
        ...(options.sessionTools !== undefined ? { sessionTools: options.sessionTools } : {}),
        ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
        ...(options.browserConnect !== undefined ? { browserConnect: options.browserConnect } : {}),
    });
}
