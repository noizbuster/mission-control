import {
    type AskUserQuestionRequest,
    type BrowserConnectFn,
    type ChildHostCallbacks,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createNativesClient,
    type EvalContextManagerFactory,
    type LspClient,
    type LspServerManagerDeps,
    type McpConnectionManager,
    type ObservabilityRedactor,
    type ProjectTrustReader,
    type ProviderAuthStore,
    type SdkModelResolver,
    type SessionToolsOptions,
    type TaskToolRuntimeServices,
    type WorkflowRegistry,
} from '@mission-control/core';
import type { AgentEvent, MissionControlConfig, ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import type { ApprovalLevel } from '@mission-control/tui/state';
import type { InteractiveApprovalBroker } from './interactive-approval-broker';
import type { ChatOutput } from './interactive-chat-io';
import type { ProductionToolRegistry } from './production-tool-registry';
import {
    type InteractivePlanExitToolOptions,
    type ParentMiscToolHostOptions,
    registerDefaultCodingTools,
} from './register-default-coding-tools';

export type InteractiveToolOptions = ParentMiscToolHostOptions & {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly enableTrustedBash?: boolean;
    readonly tmuxAvailable?: boolean;
    readonly ghAvailable?: () => boolean;
    readonly evalContextManagerFactory?: EvalContextManagerFactory;
    readonly projectTrustStore?: ProjectTrustReader;
    readonly resolveSdkModel?: SdkModelResolver;
    readonly mcpConnectionManager?: McpConnectionManager;
    readonly lspClient?: LspClient;
    readonly lspServerManagerDeps?: LspServerManagerDeps;
    readonly requestUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
    readonly requestUserQuestions?: (requests: readonly AskUserQuestionRequest[]) => Promise<string[]>;
    readonly approvalLevel?: ApprovalLevel;
    readonly authStore?: ProviderAuthStore;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly onWorkflowStarted?: (spec: WorkflowSpec, prompt: string) => void;
    readonly planExit?: InteractivePlanExitToolOptions;
    readonly services?: TaskToolRuntimeServices;
    readonly sessionTools?: SessionToolsOptions;
    readonly profileName?: string;
    readonly childHostCallbacks?: ChildHostCallbacks;
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly browserConnect?: BrowserConnectFn;
    readonly config?: MissionControlConfig;
};

export { preflightInteractiveToolCall } from './interactive-coding-tool-approval';

export async function createInteractiveToolRegistry(
    options: InteractiveToolOptions,
    approvals: InteractiveApprovalBroker,
): Promise<ProductionToolRegistry> {
    const natives = createNativesClient({ onWarning: () => {} });
    return registerDefaultCodingTools({
        hostKind: 'interactive',
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
        natives,
        enableTrustedBash: options.enableTrustedBash === true,
        ...(options.tmuxAvailable !== undefined ? { tmuxAvailable: options.tmuxAvailable } : {}),
        ...(options.ghAvailable !== undefined ? { ghAvailable: options.ghAvailable } : {}),
        config: options.config ?? {},
        sessionId: options.sessionId,
        modelProviderSelection: options.modelProviderSelection,
        ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
        ...(options.evalContextManagerFactory !== undefined
            ? { evalContextManagerFactory: options.evalContextManagerFactory }
            : {}),
        ...(options.projectTrustStore !== undefined ? { projectTrustStore: options.projectTrustStore } : {}),
        ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
        ...(options.mcpConnectionManager !== undefined ? { mcpConnectionManager: options.mcpConnectionManager } : {}),
        ...(options.lspClient !== undefined ? { lspClient: options.lspClient } : {}),
        ...(options.lspServerManagerDeps !== undefined ? { lspServerManagerDeps: options.lspServerManagerDeps } : {}),
        ...(options.requestUserQuestion !== undefined ? { requestUserQuestion: options.requestUserQuestion } : {}),
        ...(options.requestUserQuestions !== undefined ? { requestUserQuestions: options.requestUserQuestions } : {}),
        ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
        ...(options.workflowRegistry !== undefined ? { workflowRegistry: options.workflowRegistry } : {}),
        ...(options.onWorkflowStarted !== undefined ? { onWorkflowStarted: options.onWorkflowStarted } : {}),
        ...(options.planExit !== undefined ? { planExit: options.planExit } : {}),
        ...(options.goalRuntime !== undefined ? { goalRuntime: options.goalRuntime } : {}),
        ...(options.reportToolIssueSink !== undefined ? { reportToolIssueSink: options.reportToolIssueSink } : {}),
        ...(options.reportFinding !== undefined ? { reportFinding: options.reportFinding } : {}),
        ...(options.services !== undefined
            ? { services: options.services, asyncJobManager: options.services.jobManager }
            : {}),
        ...(options.sessionTools !== undefined ? { sessionTools: options.sessionTools } : {}),
        ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
        ...(options.childHostCallbacks !== undefined ? { childHostCallbacks: options.childHostCallbacks } : {}),
        ...(options.browserConnect !== undefined ? { browserConnect: options.browserConnect } : {}),
    });
}
