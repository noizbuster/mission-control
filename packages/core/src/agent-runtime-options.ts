import type {
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    SessionDebugConfig,
} from '@mission-control/protocol';
import type { PendingApprovalBehavior, PermissionDecisionResolver } from './approval-gate';
import type { ProjectContextMessageOptions } from './context/project-context-messages';
import type { PersistentMemoryStore } from './memory/persistent-memory-store';
import type { NativesClient } from './native/natives-client';
import type { ObservabilityRedactor } from './providers/observability-redactor';
import type { ProviderAdapter } from './providers/provider-turn-types';
import type { ToolRegistry } from './tools/tool-registry';

export type RuntimeToolRegistryFactory = (
    requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
) => Promise<ToolRegistry>;

export type AgentRuntimeSessionDebugOptions = {
    readonly config: SessionDebugConfig;
    readonly dataDir: string;
    readonly natives: Pick<NativesClient, 'openSessionDebug'>;
};
export type AgentRuntimeOptions = {
    readonly useNative?: boolean;
    readonly sidecarCommand?: string;
    readonly sidecarTimeoutMs?: number;
    readonly enableSidecarProtocolV2?: boolean;
    readonly enableSidecarProtocolV3?: boolean;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly provider?: ProviderAdapter;
    readonly providerTimeoutMs?: number;
    readonly providerRetryLimit?: number;
    readonly providerTurnLoopLimit?: number;
    readonly projectContext?: ProjectContextMessageOptions;
    readonly workspaceRoot?: string;
    readonly createToolRegistry?: RuntimeToolRegistryFactory;
    readonly permissionDecisionResolver?: PermissionDecisionResolver;
    readonly pendingApprovalBehavior?: PendingApprovalBehavior;
    readonly persistentStore?: PersistentMemoryStore;
    readonly observabilityRedactor?: ObservabilityRedactor;
    /** Optional, session-scoped native diagnostic capture; never changes agent behavior. */
    readonly sessionDebug?: AgentRuntimeSessionDebugOptions;
};
