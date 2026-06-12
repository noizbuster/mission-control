import type {
    AgentRuntimeOptions,
    CommandExecutionRequest,
    CommandExecutionResult,
    ProviderAdapter,
} from '@mission-control/core';
import type { ModelProviderSelection, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { createCliPermissionDecision, type NonInteractiveAutomationPolicy } from './cli-permission-policy.js';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';

type CliRuntimeOptionsInput = {
    readonly useNative?: boolean;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly provider: ProviderAdapter;
    readonly workspaceRoot?: string;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly nonInteractiveAutomationPolicy?: NonInteractiveAutomationPolicy;
};

export function createCliRuntimeOptions(input: CliRuntimeOptionsInput): AgentRuntimeOptions {
    return {
        ...(input.useNative !== undefined ? { useNative: input.useNative } : {}),
        ...(input.modelProviderSelection !== undefined ? { modelProviderSelection: input.modelProviderSelection } : {}),
        provider: input.provider,
        createToolRegistry: (requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>) =>
            createNonInteractiveToolRegistry({
                workspaceRoot: input.workspaceRoot ?? process.cwd(),
                requestPermission,
                ...(input.commandExecutor !== undefined ? { commandExecutor: input.commandExecutor } : {}),
            }),
        permissionDecisionResolver: (request) =>
            createCliPermissionDecision(request, input.nonInteractiveAutomationPolicy),
        pendingApprovalBehavior: 'block',
    };
}
export type { NonInteractiveAutomationPolicy };
