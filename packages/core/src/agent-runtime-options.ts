import type { ModelProviderSelection } from '@mission-control/protocol';
import type { PendingApprovalBehavior, PermissionDecisionResolver } from './approval-gate.js';
import type { ProviderAdapter } from './providers/provider-turn-types.js';

export type AgentRuntimeOptions = {
    readonly useNative?: boolean;
    readonly sidecarCommand?: string;
    readonly sidecarTimeoutMs?: number;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly provider?: ProviderAdapter;
    readonly providerTimeoutMs?: number;
    readonly providerRetryLimit?: number;
    readonly providerTurnLoopLimit?: number;
    readonly permissionDecisionResolver?: PermissionDecisionResolver;
    readonly pendingApprovalBehavior?: PendingApprovalBehavior;
};
