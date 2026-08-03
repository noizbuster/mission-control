import {
    type AgentRuntimeOptions,
    type AgentRuntimeSessionDebugOptions,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type LspClient,
    type ObservabilityRedactor,
    type PersistentMemoryStore,
    type ProviderAdapter,
} from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { createCliPermissionDecision, type NonInteractiveAutomationPolicy } from './cli-permission-policy';

type CliRuntimeOptionsInput = {
    readonly useNative?: boolean;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly provider: ProviderAdapter;
    readonly workspaceRoot?: string;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly nonInteractiveAutomationPolicy?: NonInteractiveAutomationPolicy;
    /** LSP seam: inject a real `LspClient` to register the `lsp` tool. Default undefined (off). */
    readonly lspClient?: LspClient;
    readonly persistentStore?: PersistentMemoryStore;
    readonly profileName?: string;
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly sessionDebug?: AgentRuntimeSessionDebugOptions;
};

export function createCliRuntimeOptions(input: CliRuntimeOptionsInput): AgentRuntimeOptions {
    return {
        ...(input.useNative !== undefined ? { useNative: input.useNative } : {}),
        ...(input.modelProviderSelection !== undefined ? { modelProviderSelection: input.modelProviderSelection } : {}),
        ...(input.workspaceRoot !== undefined
            ? { projectContext: { workspaceRoot: input.workspaceRoot }, workspaceRoot: input.workspaceRoot }
            : {}),
        provider: input.provider,
        permissionDecisionResolver: (request) =>
            createCliPermissionDecision(request, {
                ...(input.nonInteractiveAutomationPolicy !== undefined
                    ? { automationPolicy: input.nonInteractiveAutomationPolicy }
                    : {}),
                workspaceRoot: input.workspaceRoot ?? process.cwd(),
            }),
        pendingApprovalBehavior: 'block',
        ...(input.observabilityRedactor !== undefined ? { observabilityRedactor: input.observabilityRedactor } : {}),
        ...(input.persistentStore !== undefined ? { persistentStore: input.persistentStore } : {}),
        ...(input.sessionDebug !== undefined ? { sessionDebug: input.sessionDebug } : {}),
    };
}
export type { NonInteractiveAutomationPolicy };
