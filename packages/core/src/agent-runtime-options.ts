import type { ModelProviderSelection, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import type { PendingApprovalBehavior, PermissionDecisionResolver } from './approval-gate.js';
import type { ProjectContextMessageOptions } from './context/project-context-messages.js';
import type { ProviderAdapter } from './providers/provider-turn-types.js';
import type { ToolRegistry } from './tools/tool-registry.js';

export type RuntimeToolRegistryFactory = (
    requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
) => Promise<ToolRegistry>;

export type AgentRuntimeOptions = {
    readonly useNative?: boolean;
    readonly sidecarCommand?: string;
    readonly sidecarTimeoutMs?: number;
    readonly enableSidecarProtocolV2?: boolean;
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
};
