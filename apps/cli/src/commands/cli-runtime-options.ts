import {
    type AgentRuntimeOptions,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type LspClient,
    type PersistentMemoryStore,
    ProjectTrustStore,
    type ProviderAdapter,
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
    /** LSP seam: inject a real `LspClient` to register the `lsp` tool. Default undefined (off). */
    readonly lspClient?: LspClient;
    readonly persistentStore?: PersistentMemoryStore;
};

export function createCliRuntimeOptions(input: CliRuntimeOptionsInput): AgentRuntimeOptions {
    return {
        ...(input.useNative !== undefined ? { useNative: input.useNative } : {}),
        ...(input.modelProviderSelection !== undefined ? { modelProviderSelection: input.modelProviderSelection } : {}),
        ...(input.workspaceRoot !== undefined
            ? { projectContext: { workspaceRoot: input.workspaceRoot }, workspaceRoot: input.workspaceRoot }
            : {}),
        provider: input.provider,
        createToolRegistry: (requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>) =>
            workspaceHasTrustedBash(input.workspaceRoot ?? process.cwd()).then(async (enableTrustedBash) => {
                const { registry, mcpConnectionManager } = await createNonInteractiveToolRegistry({
                    workspaceRoot: input.workspaceRoot ?? process.cwd(),
                    requestPermission,
                    enableTrustedBash,
                    ...(input.commandExecutor !== undefined ? { commandExecutor: input.commandExecutor } : {}),
                    ...(input.lspClient !== undefined ? { lspClient: input.lspClient } : {}),
                });
                void mcpConnectionManager.disconnectAll();
                return registry;
            }),
        permissionDecisionResolver: (request) =>
            createCliPermissionDecision(request, {
                ...(input.nonInteractiveAutomationPolicy !== undefined
                    ? { automationPolicy: input.nonInteractiveAutomationPolicy }
                    : {}),
                workspaceRoot: input.workspaceRoot ?? process.cwd(),
            }),
        pendingApprovalBehavior: 'block',
        ...(input.persistentStore !== undefined ? { persistentStore: input.persistentStore } : {}),
    };
}
export type { NonInteractiveAutomationPolicy };

async function workspaceHasTrustedBash(workspaceRoot: string): Promise<boolean> {
    const trust = await new ProjectTrustStore().getDecision(workspaceRoot);
    return trust.decision === 'trusted';
}
