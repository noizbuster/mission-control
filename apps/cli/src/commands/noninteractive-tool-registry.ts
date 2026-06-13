import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createReadOnlyRepoToolRegistrations,
    registerBashRunTool,
    registerCommandRunTool,
    registerFileEditTool,
    registerFilePatchTool,
    registerFileWriteTool,
    ToolRegistry,
} from '@mission-control/core';
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { cliAllowsAction } from './cli-permission-policy.js';

type NonInteractiveToolRegistryOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly enableTrustedBash?: boolean;
};

export async function createNonInteractiveToolRegistry(
    options: NonInteractiveToolRegistryOptions,
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const readTools = await createReadOnlyRepoToolRegistrations({
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    registry.register(readTools[0]);
    registry.register(readTools[1]);
    registry.register(readTools[2]);
    await registerFileEditTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerFileWriteTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerFilePatchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    if (options.enableTrustedBash === true && cliAllowsAction('bash.run')) {
        await registerBashRunTool(registry, {
            workspaceRoot: options.workspaceRoot,
            workspaceTrust: 'trusted',
            requestPermission: options.requestPermission,
            ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
        });
    }
    return registry;
}
