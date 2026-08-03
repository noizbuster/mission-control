// allow: SIZE_OK -- HEAD 581 -> current 598 pure LOC; explicit public API export barrel retained for compatibility review.
export * from './abg-overlay/index';
export type { AgentRuntimeOptions, AgentRuntimeSessionDebugOptions, RunGraphOptions } from './agent-runtime';
export { AgentRuntime } from './agent-runtime';
export * from './agents/index';
export { SubAgentRegistry } from './agents/registry';
export type { SubAgent, SubAgentRunInput, SubAgentRunOutput } from './agents/sub-agent';
export type { ApprovalTerminalState, ApprovalUpdateInput, PermissionDecisionResolver } from './approval-gate';
export { PermissionGate, PermissionGateError } from './approval-gate';
export type { ActionGraph, ActionGraphEdge, ActionGraphNode } from './behavior/action-graph';
export { createActionGraph } from './behavior/action-graph';
export type { AgentModelLookup } from './behavior/agent-model-resolver';
export { resolveGraphAgentModels } from './behavior/agent-model-resolver';
export type { AuthorableAbgGraph } from './behavior/authorable-graph';
export { createAuthorableAbgGraph, resolveAbgNodeModel } from './behavior/authorable-graph';
export type { BehaviorNode, BehaviorNodeType } from './behavior/behavior-node';
export {
    type AgentNodeRunBudgetGrantorOptions,
    createAgentNodeRunBudgetGrantor,
    formatBudgetRequestPrompt,
} from './behavior/budget/agent-node-run-budget-grantor';
export {
    type BudgetConfig,
    type BudgetCostEvent,
    type CostBreakdown,
    CostLedger,
    type CostLedgerTotals,
    createCostLedger,
    DEFAULT_PRICING,
    estimateCostCents,
    extractTokenUsage,
    type ModelSelection,
    type PricingEntry,
    type PricingTable,
    resolvePricing,
    type TokenUsage,
} from './behavior/budget/cost-ledger';
export {
    type ApplyNodeRunBudgetGrantInput,
    type ApplyNodeRunBudgetGrantResult,
    applyNodeRunBudgetGrant,
    DEFAULT_MAX_NODE_RUN_BUDGET_EXTENSIONS,
    DEFAULT_NODE_RUN_BUDGET_GRANT,
    hardCeilingForNodeRunBudget,
    type NodeRunBudgetExtensionDecision,
    type NodeRunBudgetExtensionRequest,
    type NodeRunBudgetExtensionRequester,
    parseAgentBudgetDecisionText,
} from './behavior/budget/node-run-budget-extension';
export { BUILTIN_MODES, BUILTIN_WORKFLOWS, registerBuiltinWorkflows } from './behavior/builtin-workflows';
export {
    CODING_AGENT_GRAPH_ID,
    type CodingAgentGraphOptions,
    createCodingAgentGraph,
} from './behavior/coding-agent-graph';
export { createCodingAgentNodeRegistry } from './behavior/coding-agent-registry';
export type { AbgGraphRunnerInput, AbgGraphRunResult } from './behavior/graph-runner';
export { runAbgGraph } from './behavior/graph-runner';
export { deriveAbgGraphSnapshot } from './behavior/graph-state';
export type { AbgNodeRegistry, AbgNodeRunContext, AbgNodeRunner } from './behavior/node-registry';
export {
    AbgNodeRegistryError,
    createAbgNodeRegistry,
    createDefaultAbgNodeRegistry,
    runAbgNode,
} from './behavior/node-registry';
export { bustSkillCache } from './behavior/nodes/llm-actor/llm-actor-skill-cache';
export type { AbgRuleEvaluationInput, CompiledAbgRule } from './behavior/rule-compiler';
export { AbgGraphValidationError, compileAbgRule } from './behavior/rule-compiler';
export type { AbgSignalProjectionInput } from './behavior/signals';
export { projectAbgSignalToEvent } from './behavior/signals';
export type { ChildHostCallbacks } from './behavior/subagents/spawn-child';
export type { AbgTimelineEntry } from './behavior/timeline';
export { projectAbgTimeline } from './behavior/timeline';
export type { CancellationToken, TaskHandle, TaskStatus } from './cancellation';
export {
    DEFAULT_CONTEXT_BUDGET_TOKENS,
    DEFAULT_TAIL_RESERVE_TOKENS,
    type PackContextInput,
    type PackedContext,
    packContext,
} from './context/context-packer';
export {
    emitMidConversationSystemMessage,
    type MidConversationEmitResult,
    type SystemMessage,
} from './context/mid-conversation-message';
export {
    loadProjectContextMessages,
    type ProjectContextMessageOptions,
    type ProjectInstructionResource,
    prependProjectContextMessages,
} from './context/project-context-messages';
export {
    type DeniedProjectResource,
    defaultProjectResourcePaths,
    loadProjectResources,
    type ProjectResource,
    type ProjectResourceLoadInput,
    type ProjectResourceLoadResult,
} from './context/project-resource-loader';
export {
    type AdmittedSnapshot,
    type ContextUpdateBatch,
    jsonContextCodec,
    type LoadedSource,
    type PackedSystemContextSource,
    packSystemContextSource,
    type SourceComparison,
    type SourceObservation,
    type SystemContextCodec,
    type SystemContextKey,
    SystemContextRegistry,
    SystemContextRegistryError,
    type SystemContextRegistryErrorCode,
    type SystemContextSource,
    stringContextCodec,
} from './context/system-context-source';
export {
    type AssembleSystemPromptInput,
    assembleSystemPrompt,
    DEFAULT_CODING_AGENT_PERSONA,
    type SystemPromptEnvironment,
    type SystemPromptSkill,
    type SystemPromptToolSnippet,
    type SystemPromptWorkflow,
} from './context/system-prompt';
export { type LocalLibsqlDb, runLocalLibsqlWrite } from './db/local-libsql-db';
export {
    DESKTOP_APPROVAL_EFFECT_OUTCOMES,
    type DesktopApprovalEffect,
    type DesktopApprovalEffectClaimInput,
    type DesktopApprovalEffectClaimResult,
    type DesktopApprovalEffectExecutingRecord,
    type DesktopApprovalEffectOutcome,
    type DesktopApprovalEffectPendingRecord,
    type DesktopApprovalEffectRecord,
    type DesktopApprovalEffectResolutionInput,
    type DesktopApprovalEffectSettledRecord,
    type DesktopApprovalEffectSettlementInput,
    type DesktopApprovalEffectUnknownRecord,
} from './desktop-approval-effect';
export {
    hasPendingDesktopApprovals,
    prepareSessionCompaction,
    projectApprovalContinuationMessages,
    projectApprovalContinuationTranscript,
    projectDesktopApprovalContinuationMessages,
    type SequencedAgentMessage,
    type SessionCompactionPreparation,
} from './desktop-approval-transcript';
export {
    createDesktopSessionCommandService,
    type DesktopApprovalEffectQueryInput,
    type DesktopApprovalEffectResolutionCommandInput,
    type DesktopApprovalEffectResolutionReceipt,
    type DesktopCommandReceipt,
    type DesktopPromptCommandInput,
    type DesktopRunCommandInput,
    type DesktopSessionCommandService,
    type DesktopSessionCommandServiceOptions,
} from './desktop-session-commands';
export {
    type DesktopApprovalDecisionInput,
    type DesktopApprovalSettlementOptions,
    type DesktopApprovalSettlementStatus,
    type DesktopApprovalStore,
    ensurePendingToolApprovalForCurrentBlockedRun,
    settleDesktopApproval,
} from './desktop-tool-approvals';
export { EventBus } from './event-bus';
export {
    type Blackboard,
    type BlackboardEntry,
    type BlackboardMutationKind,
    type BlackboardMutationObserver,
    type BlackboardMutationPayload,
    type BlackboardOptions,
    createBlackboard,
} from './memory/blackboard';
export * from './memory/index';
export {
    type CreateNativesClientOptions,
    createNativesClient,
    type NativeSessionDebugHandle,
    type NativeSessionDebugOpenOptions,
    type NativeSessionDebugStatus,
    type NativesClient,
} from './native/natives-client';
export {
    PermissionAuthorityCommitCancelledError,
    PermissionSession,
    type PermissionSessionOptions,
    type RememberReplyOptions,
} from './permission/session';
export { PermissionRuleStore, type PermissionRuleStoreOptions } from './permission/store';
export { createAllowPermissionDecision, createDefaultPermissionDecision } from './permissions';
export {
    type AtomicWriteFileOptions,
    atomicWriteFile,
    atomicWriteJsonFile,
    atomicWriteTextFile,
} from './persistence/atomic-write';
export { readBoulder } from './persistence/boulder-store';
export {
    ensureMcDirs,
    MC_DIR_NAME,
    McPersistenceError,
    resolveMcRoot,
} from './persistence/paths';
export * from './plugins/index';
export {
    FlatProviderBridgeError,
    type FlatProviderBridgeOptions,
    wrapFlatProviderAsSdkModel,
} from './providers/ai-sdk/flat-provider-bridge';
export {
    type CreateSdkModelResolverInput,
    createSdkModelResolver,
    type SdkModelResolver,
    SdkModelResolverError,
} from './providers/ai-sdk/model-resolver';
export {
    type AnthropicMessagesProviderOptions,
    type AnthropicMessagesTransport,
    AnthropicMessagesTransportError,
    type AnthropicMessagesTransportRequest,
    createAnthropicMessagesProvider,
    createNodeAnthropicMessagesTransport,
} from './providers/anthropic/anthropic-messages-provider';
export {
    createCredentialRedactions,
    createStaticProviderCredentialResolver,
    ProviderCredentialResolutionError,
    type ProviderCredentialResolutionErrorCode,
    type ProviderCredentialResolveInput,
    type ProviderCredentialResolver,
    REDACTED_CREDENTIAL,
    redactCredentialText,
    summarizeResolvedProviderCredential,
} from './providers/credential-resolver';
export {
    createDeterministicProvider,
    type DeterministicProvider,
    type DeterministicProviderStep,
} from './providers/deterministic-provider';
export {
    createGeminiGenerateContentProvider,
    createNodeGeminiGenerateContentTransport,
    type GeminiGenerateContentProviderOptions,
    type GeminiGenerateContentTransport,
    GeminiGenerateContentTransportError,
    type GeminiGenerateContentTransportRequest,
} from './providers/google/gemini-generate-content-provider';
export { createLocalCodingProvider } from './providers/local-coding-provider';
export {
    type CreateOAuthRefreshingCredentialResolverInput,
    createOAuthRefreshingCredentialResolver,
    DEFAULT_OAUTH_REFRESH_SKEW_MS,
    type OAuthCredentialPersist,
    type OAuthTokenRefresher,
    oauthCredentialNeedsRefresh,
} from './providers/oauth-credential-refresh';
export {
    composeObservabilityRedactors,
    createObservabilityRedactor,
    OBSERVABILITY_CIRCULAR,
    OBSERVABILITY_REDACTION_MAX_BYTES,
    OBSERVABILITY_REDACTION_MAX_DEPTH,
    OBSERVABILITY_REDACTION_MAX_ENTRIES,
    OBSERVABILITY_TRUNCATED,
    type ObservabilityRedactor,
    type ObservabilityRedactorOptions,
    redactAbgSignalForObservability,
    redactAgentEventEnvelopeForObservability,
    redactAgentEventForObservability,
} from './providers/observability-redactor';
export {
    createNodeOpenAIResponsesTransport,
    createOpenAIResponsesProvider,
    type OpenAIResponsesProviderOptions,
    type OpenAIResponsesTransport,
    OpenAIResponsesTransportError,
    type OpenAIResponsesTransportRequest,
} from './providers/openai/openai-responses-provider';
export {
    createNodeOpenAICompatibleTransport,
    createOpenAICompatibleProvider,
    OPENAI_COMPATIBLE_PROVIDER_SPECS,
    type OpenAICompatibleProviderOptions,
    type OpenAICompatibleProviderSpec,
    type OpenAICompatibleTransport,
    OpenAICompatibleTransportError,
    type OpenAICompatibleTransportRequest,
} from './providers/openai-compatible/openai-compatible-provider';
export {
    createProviderAuthStoreCredentialResolver,
    createProviderAuthStoreObservabilityRedactor,
    type ProviderAuthStoreCredentialResolverAuthStore,
    redactProviderAuthStoreCredentialText,
    summarizeProviderCredential,
} from './providers/provider-auth-resolver';
export {
    createProviderAuthStore,
    type ProviderAuthStore,
    type SaveProviderCredentialFieldInput,
    type SaveProviderCredentialInput,
    type SaveProviderOAuthCredentialInput,
} from './providers/provider-auth-store';
export {
    createProviderForSelection,
    createProviderRouter,
    type ProviderFactoryOptions,
    type ProviderFactoryTransports,
} from './providers/provider-factory';
export { ProviderTurnRunner } from './providers/provider-turn-runner';
export {
    DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS,
    MAX_PROVIDER_CHUNK_TIMEOUT_MS,
    nextProviderChunkTimeoutMs,
} from './providers/provider-turn-timeout';
export type {
    ProviderAdapter,
    ProviderAdapterContext,
    ProviderTurnEnvelopeObserver,
    ProviderTurnEventIdFactory,
    ProviderTurnEventWriter,
    ProviderTurnRequest,
    ProviderTurnRunInput,
    ProviderTurnRunnerOptions,
    ProviderTurnRunResult,
} from './providers/provider-turn-types';
export { ProviderTurnError } from './providers/provider-turn-types';
export { createStreamDecoder, type StreamDecoder, truncateToValidUtf8Boundary } from './providers/stream-decoder';
export {
    type ContinuationOptions,
    type ContinuationOutcome,
    ContinuationRuntime,
    ContinuationRuntimeError,
    type ContinuationState,
} from './runtime/continuation/continuation-runtime';
export type { AgentExecutionContext, AgentTask, AgentTaskResult } from './runtime/execution-context';
export type { AgentExecutor } from './runtime/executor';
export { createGraphTurnRunner, type GraphTurnRunnerWiring } from './runtime/graph-coordinator-turn';
export {
    findLatestGraphCheckpoint,
    findResumableRun,
    type GraphCheckpointSearchOptions,
    type GraphResumeEvent,
    latestGraphIdFromEvents,
    type ResumableRunSnapshot,
} from './runtime/graph-resume-state';
export { openCanonicalRuntimeDb } from './runtime/local-runtime-db';
export {
    blockRun,
    cancelRun,
    completeRun,
    failRun,
    materializeMission,
    settleMissionRunSessionOwner,
    startRun,
} from './runtime/mission-run/mission-run-service';
export {
    type MissionRunStoreLocation,
    type NormalizedMissionRunStoreLocation,
    normalizeMissionRunStoreLocation,
} from './runtime/mission-run/mission-run-store-location';
export {
    createMission,
    listMissions,
    readMission,
    updateMission,
} from './runtime/mission-run/mission-store';
export {
    attachRunSessionOwner,
    type RunSessionOwnerAttachment,
    type RunSessionOwnerSettlement,
    settleRunSessionOwner,
} from './runtime/mission-run/run-session-owner-store';
export {
    ALLOWED_RUN_TRANSITIONS,
    appendChildSession,
    assertRunTransition,
    createRun,
    findMostRecentFailedRun,
    listRunsForMission,
    readRun,
    recordTaskRetry,
    TERMINAL_RUN_STATUSES,
    updateRunStatus,
} from './runtime/mission-run/run-store';
export {
    type RunCoordinatorPromptInput,
    type RunCoordinatorResult,
    type RunCoordinatorStore,
    type RunCoordinatorTurnCommand,
    type RunCoordinatorTurnContext,
    type RunCoordinatorTurnRunner,
    SessionRunCoordinator,
    type SessionRunCoordinatorOptions,
} from './runtime/run-coordinator';
export { findResumableBlockedRun } from './runtime/run-coordinator-drain';
export {
    SessionRunOwner,
    type SessionRunOwnerLeaseInput,
    type SessionRunOwnerOptions,
    type SessionRunOwnerReceipt,
    SessionRunOwnerRegistry,
    type SessionRunOwnerRegistryOptions,
} from './runtime/run-owner';
export type { AgentScheduler } from './runtime/scheduler';
export { MockAgentScheduler } from './runtime/scheduler';
export type {
    SessionControlCallbackFence,
    SessionControlCallbackHandleKind,
    SessionControlCancellation,
    SessionControlEpoch,
} from './runtime/session-control-cancellation';
export {
    type SessionControlAccessToken,
    type SessionControlAttachedHandle,
    type SessionControlAttachment,
    type SessionControlEntityKind,
    type SessionControlEntitySnapshot,
    SessionControlFencedError,
    SessionControlHost,
    type SessionControlHostPublisher,
    type SessionControlStopContext,
} from './runtime/session-control-host';
export {
    acquireSessionControlLease,
    expireSessionControlLease,
    readSessionControlLease,
    renewSessionControlLease,
    runWithSessionControlLeaseFence,
    SESSION_CONTROL_LEASE_TTL_MS,
    type SessionControlLease,
    type SessionControlLeaseAcquisition,
    SessionControlLeaseError,
    type SessionControlLeaseErrorCode,
} from './runtime/session-control-lease';
export {
    SESSION_CONTROL_RENEW_INTERVAL_MS,
    type SessionControlLeaseRenewer,
    startSessionControlLeaseRenewer,
} from './runtime/session-control-lease-renewer';
export {
    completeSessionControlOperation,
    createSessionControlCallbackFence,
    createSessionControlOperation,
    gcSessionControlOperations,
    readSessionControlOperation,
    recoverExpiredSessionControlOperations,
    redactLateSettlementMetadata,
    SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
    SESSION_CONTROL_GC_INTERVAL_MS,
    SESSION_CONTROL_LATE_SETTLEMENT_RETENTION_MS,
    SESSION_CONTROL_SETTLED_RETENTION_MS,
    type SessionControlLateSettlementMetadata,
    type SessionControlOperation,
    type SessionControlOperationStatus,
    type SessionControlOperationTimer,
    settleSessionControlOperationHandle,
    startSessionControlOperationDeadline,
    startSessionControlOperationGc,
    timeoutSessionControlOperation,
} from './runtime/session-control-operation';
export {
    type PosixSessionControlOwner,
    publishPosixSessionControlOwner,
    resolveAuthenticatedPosixSessionControlOwner,
    SessionControlOwnerError,
} from './runtime/session-control-owner-posix';
export {
    closeProcessSessionControlHosts,
    fenceProcessSessionControlHosts,
    getProcessSessionControlHost,
} from './runtime/session-control-process-host';
export {
    type AuthenticatedSessionControlServer,
    authenticateSessionControlEndpoint,
    createAuthenticatedSessionControlServer,
    generateSessionControlNonce,
    matchesSessionControlNonce,
    sessionControlNonceHash,
} from './runtime/session-control-registry-auth';
export {
    publishSessionControlRegistry,
    readSessionControlRegistry,
    type SessionControlRegistry,
    serializeSessionControlRegistry,
} from './runtime/session-control-registry-file';
export {
    type PosixSessionControlPaths,
    type ResolvePosixSessionControlPathsInput,
    resolvePosixSessionControlPaths,
    SessionControlRegistryError,
    type SessionControlRegistryErrorCode,
    sessionControlRegistryFileName,
    sessionControlSocketName,
} from './runtime/session-control-registry-paths';
export {
    CRASH_RECOVERY_LEASE_GRACE_MS,
    type ReconcileCrashedSessionsOptions,
    type ReconcileCrashedSessionsResult,
    reconcileCrashedSessions,
} from './runtime/session-crash-recovery';
export {
    createPosixSessionOwnerControlClient,
    createSessionOwnerControlClient,
    type SessionOwnerControlClient,
    SessionOwnerControlClientError,
    stopExactSessionOverOwnerControl,
} from './runtime/session-owner-control-client';
export {
    encodeSessionOwnerControlFrame,
    parseSessionOwnerControlFrame,
    SESSION_OWNER_CONTROL_MAX_FRAME_BYTES,
    SessionOwnerControlFrameError,
} from './runtime/session-owner-control-framing';
export { appendFencedSessionStopEvent } from './runtime/session-stop-event-writer';
export {
    type ExactSessionStopAcquisition,
    type ExactSessionStopInput,
    type SessionStopReceipt,
    SessionStopService,
} from './runtime/session-stop-service';
export {
    SESSION_STOP_TREE_MAX_RESCANS,
    SESSION_STOP_TREE_MAX_SESSIONS,
    SESSION_STOP_TREE_MAX_TIMEOUT_MS,
    SESSION_STOP_TREE_RETRY_DELAY_MS,
    type SessionStopTreeResult,
    type SessionStopTreeSessionResult,
    type StopSessionTreeInput,
    stopSessionTree,
} from './runtime/session-stop-tree';
export {
    SESSION_STOP_TREE_SHARED_FIXTURES,
    type SessionStopTreeSharedFixture,
} from './runtime/session-stop-tree-fixtures';
export {
    type StopLocalSessionTreeInput,
    stopLocalSessionTree,
} from './runtime/session-stop-tree-local';
export {
    type CanonicalSessionTreeDescendant,
    type CanonicalSessionTreeNode,
    type CanonicalSessionTreeResult,
    readCanonicalSessionTree,
    resolveCanonicalSessionTree,
} from './runtime/session-stop-tree-resolver';
export {
    formatPermissiveDataDirWarning,
    resetDataDirPermissionWarningStateForTests,
    resolveSessionStoreIdentity,
    SESSION_STORE_IDENTITY_GOLDEN_VECTORS,
    type SessionStoreIdentity,
    SessionStoreIdentityError,
    type SessionStoreIdentityErrorCode,
    type SessionStoreIdentityGoldenVector,
    sessionStoreDatabasePath,
    takeDataDirPermissionWarnings,
} from './runtime/session-store-identity';
export {
    type CanonicalSessionTreeTokenNode,
    computeCanonicalSessionTreeToken,
    encodeCanonicalSessionTree,
} from './runtime/session-tree-token';
export {
    type AdmitPromptInput,
    type ModelVisibleTranscriptMessage,
    type PromptAdmissionReceipt,
    type PromptDeliveryMode,
    type PromptInputState,
    type PromptPromotionResult,
    type PromptPromotionTrigger,
    projectSessionAdmission,
    SessionAdmissionError,
    type SessionAdmissionEventStore,
    type SessionAdmissionProjection,
    SessionAdmissionProjectionError,
    SessionAdmissionService,
    type SessionAdmissionServiceOptions,
    type TranscriptBranchNode,
    type TranscriptBranchTree,
} from './session-admission';
export { SessionEventLog } from './session-log';
export {
    type ApprovalProjection,
    type CodingReplayStep,
    type JsonlSessionReplayPrefixProjection,
    projectJsonlSessionReplayPrefix,
    projectSessionReplay,
    type ReplayDiagnostic,
    type SessionBranchNode,
    type SessionBranchSummary,
    type SessionBranchTree,
    type SessionReplayProjection,
    type SessionTreeArchiveExport,
    type SessionTreeArchiveImport,
    type SessionTreeCompactionBoundary,
    type SessionTreeNode,
    type SessionTreeProjection,
    type SessionTreeProjectionDiagnostic,
    type ToolOutcomeProjection,
    type ToolOutcomeStatus,
} from './session-replay';
export * from './skills/index';
export {
    type AskUserInput,
    type AskUserOutput,
    type AskUserQuestionRequest,
    type AskUserQuestionSource,
    type AskUserToolOptions,
    createAskUserToolRegistration,
    registerAskUserTool,
} from './tools/ask-user-tool';
export * from './tools/index';
export * from './trust/index';
export * as TuiStores from './tui-stores/index';
export { errorToString } from './util/error-to-string';
export * from './workflows/index';
