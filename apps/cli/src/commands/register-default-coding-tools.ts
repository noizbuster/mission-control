import {
    type AskUserQuestionRequest,
    type AsyncJobManager,
    type BrowserConnectFn,
    type ChildHostCallbacks,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type EvalContextManagerFactory,
    type GoalRuntime,
    type LspClient,
    type LspServerManagerDeps,
    type McpConnectionManager,
    type NativesClient,
    type PlanExitToolOptions,
    type ProjectTrustReader,
    ProjectTrustStore,
    type ProviderAuthStore,
    type ReportFindingToolOptions,
    type ReportToolIssueToolOptions,
    registerConfiguredBrowserTool,
    registerNamespacedMcpTools,
    type SdkModelResolver,
    type SessionToolsOptions,
    StagedPreviewRegistry,
    type TaskToolRuntimeServices,
    ToolRegistry,
    type WorkflowRegistry,
    wireNativesFsCacheInvalidator,
} from '@mission-control/core';
import type {
    MissionControlConfig,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    WorkflowSpec,
} from '@mission-control/protocol';
import { createGraphObservabilityRedactor } from './graph-observability-redactor';
import { registerAvailableLspTool } from './lsp-tool-registration';
import { completeProductionToolSetup, type ProductionToolRegistry } from './production-tool-registry';
import {
    registerDefaultCodingToolBase,
    registerDefaultParentJobTool,
    registerDefaultTaskTool,
} from './register-default-coding-tool-phases';
import { registerDefaultMonitorTools, registerDefaultTeamTools } from './register-default-configured-tools';

export type ParentMiscToolHostOptions = {
    readonly goalRuntime?: GoalRuntime;
    readonly reportToolIssueSink?: NonNullable<ReportToolIssueToolOptions['onIssue']>;
    readonly reportFinding?: ReportFindingToolOptions;
};

export type InteractivePlanExitToolOptions = Omit<PlanExitToolOptions, 'onSwitch'> & {
    readonly onSwitch: NonNullable<PlanExitToolOptions['onSwitch']>;
};

type DefaultCodingToolsHostOptions = ParentMiscToolHostOptions & {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly natives: NativesClient;
    readonly enableTrustedBash: boolean;
    readonly tmuxAvailable?: boolean;
    readonly ghAvailable?: () => boolean;
    /** Typed host-selected snapshot; registration never loads another config copy. */
    readonly config: MissionControlConfig;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly evalContextManagerFactory?: EvalContextManagerFactory;
    readonly projectTrustStore?: ProjectTrustReader;
    readonly resolveSdkModel?: SdkModelResolver;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly sessionId?: string;
    readonly sessionTools?: SessionToolsOptions;
    readonly services?: TaskToolRuntimeServices;
    readonly asyncJobManager?: AsyncJobManager;
    readonly mcpConnectionManager?: McpConnectionManager;
    readonly profileName?: string;
    readonly lspClient?: LspClient;
    readonly lspServerManagerDeps?: LspServerManagerDeps;
    readonly authStore?: ProviderAuthStore;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly onWorkflowStarted?: (spec: WorkflowSpec, prompt: string) => void;
    readonly browserConnect?: BrowserConnectFn;
};

type InteractiveDefaultCodingToolsOptions = DefaultCodingToolsHostOptions & {
    readonly hostKind: 'interactive';
    readonly modelProviderSelection: ModelProviderSelection;
    readonly sessionId: string;
    readonly planExit?: InteractivePlanExitToolOptions;
    readonly requestUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
    readonly requestUserQuestions?: (requests: readonly AskUserQuestionRequest[]) => Promise<string[]>;
    readonly childHostCallbacks?: ChildHostCallbacks;
};

type NoninteractiveDefaultCodingToolsOptions = DefaultCodingToolsHostOptions & {
    readonly hostKind: 'noninteractive';
};

export type RegisterDefaultCodingToolsOptions =
    | InteractiveDefaultCodingToolsOptions
    | NoninteractiveDefaultCodingToolsOptions;

export class MissingWorkspaceRootError extends Error {
    readonly name = 'MissingWorkspaceRootError';

    constructor() {
        super('workspaceRoot is required to register default coding tools');
    }
}

export async function registerDefaultCodingTools(
    options: RegisterDefaultCodingToolsOptions,
): Promise<ProductionToolRegistry> {
    if (options.workspaceRoot.trim().length === 0) throw new MissingWorkspaceRootError();
    const registry = new ToolRegistry();
    const stagedPreviewRegistry = new StagedPreviewRegistry();
    const projectTrustStore = options.projectTrustStore ?? new ProjectTrustStore();
    wireNativesFsCacheInvalidator(options.natives);
    await registerDefaultCodingToolBase(registry, stagedPreviewRegistry, options);
    if (options.hostKind === 'interactive') {
        await registerDefaultTaskTool(registry, options);
        registerDefaultParentJobTool(registry, options);
    }
    const mcpConnectionManager = await registerNamespacedMcpTools(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        ...(options.mcpConnectionManager !== undefined ? { mcpConnectionManager: options.mcpConnectionManager } : {}),
        ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
    });
    registerDefaultTeamTools(registry, options);
    const monitorCleanup = await registerDefaultMonitorTools(registry, options);
    return completeProductionToolSetup(
        { registry, mcpConnectionManager, monitorCleanup },
        options.mcpConnectionManager === undefined,
        async () => {
            const browserTool = await registerConfiguredBrowserTool(registry, {
                workspaceRoot: options.workspaceRoot,
                requestPermission: options.requestPermission,
                projectTrustStore,
                ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
                ...(options.browserConnect !== undefined ? { connect: options.browserConnect } : {}),
            });
            if (options.hostKind === 'noninteractive') {
                const observabilityRedactor = await createGraphObservabilityRedactor({
                    mcpConnectionManager,
                    ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
                });
                await registerDefaultTaskTool(registry, options, observabilityRedactor);
                registerDefaultParentJobTool(registry, options);
            }
            await registerAvailableLspTool({
                registry,
                workspaceRoot: options.workspaceRoot,
                requestPermission: options.requestPermission,
                ...(options.lspClient !== undefined ? { lspClient: options.lspClient } : {}),
                ...(options.lspServerManagerDeps !== undefined ? { deps: options.lspServerManagerDeps } : {}),
            });
            return browserTool;
        },
        options.hostKind,
    );
}
