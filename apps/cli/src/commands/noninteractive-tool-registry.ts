import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    registerCommandRunTool,
    registerFilePatchTool,
    registerReadOnlyRepoTools,
    ToolRegistry,
} from '@mission-control/core';
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';

type NonInteractiveToolRegistryOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

export async function createNonInteractiveToolRegistry(
    options: NonInteractiveToolRegistryOptions,
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerReadOnlyRepoTools(registry, { workspaceRoot: options.workspaceRoot });
    await registerFilePatchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    return registry;
}
