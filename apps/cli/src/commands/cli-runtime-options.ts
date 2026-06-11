import type { AgentRuntimeOptions, ProviderAdapter } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { createCliPermissionDecision } from './cli-permission-policy.js';

type CliRuntimeOptionsInput = {
    readonly useNative?: boolean;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly provider: ProviderAdapter;
};

export function createCliRuntimeOptions(input: CliRuntimeOptionsInput): AgentRuntimeOptions {
    return {
        ...(input.useNative !== undefined ? { useNative: input.useNative } : {}),
        ...(input.modelProviderSelection !== undefined ? { modelProviderSelection: input.modelProviderSelection } : {}),
        provider: input.provider,
        permissionDecisionResolver: createCliPermissionDecision,
        pendingApprovalBehavior: 'block',
    };
}
