import type {
    AskUserQuestionRequest,
    CommandExecutionRequest,
    CommandExecutionResult,
    LocalSessionEventStore,
    LspClient,
    PermissionSession,
    PricingTable,
    ProviderAdapter,
    ProviderAuthStore,
    SdkModelResolver,
    SessionRunOwnerReceipt,
    TaskToolRuntimeServices,
    WorkflowRegistry,
} from '@mission-control/core';
import type {
    AbgGraphSpec,
    AgentEvent,
    MissionControlConfig,
    ModelProviderSelection,
    WorkflowSpec,
} from '@mission-control/protocol';
import type { AbgOverlayController, ApprovalLevel } from '@mission-control/tui/state';
import type { ChatOutput } from './interactive-chat-io';

export type ActiveCodingAgentTurn = {
    readonly done: Promise<void>;
    readonly outcome?: Promise<ActiveCodingAgentTurnOutcome>;
    readonly interrupt: (mode?: InterruptMode) => void;
    readonly answerApproval: (line: string) => boolean;
    readonly hasPendingApproval: () => boolean;
    readonly setApprovalLevel: (level: ApprovalLevel) => void;
};

export type InterruptMode = 'soft' | 'force';
export type ActiveCodingAgentTurnOutcome = SessionRunOwnerReceipt['status'];

export type CodingAgentTurnOptions = {
    readonly prompt: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly store: LocalSessionEventStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly workspaceRoot: string;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly observeStoredEvent?: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly engine?: 'graph';
    readonly resolveSdkModel?: SdkModelResolver;
    readonly lspClient?: LspClient;
    readonly requestUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
    readonly requestUserQuestions?: (requests: readonly AskUserQuestionRequest[]) => Promise<string[]>;
    readonly abgOverlayController?: AbgOverlayController;
    readonly pricingTable?: PricingTable;
    readonly approvalLevel?: ApprovalLevel;
    readonly authStore?: ProviderAuthStore;
    readonly graph?: AbgGraphSpec;
    readonly permissionSession?: PermissionSession;
    readonly onUsage?: (inputTokens: number | undefined) => void;
    readonly workflowRegistry?: WorkflowRegistry;
    readonly onWorkflowStarted?: (spec: WorkflowSpec, prompt: string) => void;
    readonly profileName?: string;
    readonly config?: MissionControlConfig;
    readonly taskRuntimeServices?: TaskToolRuntimeServices;
};
