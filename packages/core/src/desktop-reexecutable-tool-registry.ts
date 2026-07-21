import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import type { CommandExecutionRequest, CommandExecutionResult } from './tools/command-run';
import { registerCommandRunTool } from './tools/command-run';
import { registerFileEditTool } from './tools/file-edit';
import { registerFilePatchTool } from './tools/file-patch';
import { registerFileWriteTool } from './tools/file-write';
import { registerGlobTool } from './tools/glob-tool-factory';
import { registerHashlineEditTool } from './tools/hashline-edit';
import { registerReadOnlyRepoTools } from './tools/read-tools';
import { registerRipgrepTool } from './tools/ripgrep-tool-factory';
import { ToolRegistry } from './tools/tool-registry';

export type DesktopReExecutableToolRegistryOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

export async function createDesktopReExecutableToolRegistry(
    options: DesktopReExecutableToolRegistryOptions,
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerReadOnlyRepoTools(registry, { workspaceRoot: options.workspaceRoot });
    await registerGlobTool(registry, { workspaceRoot: options.workspaceRoot });
    await registerRipgrepTool(registry, { workspaceRoot: options.workspaceRoot });
    await registerFileEditTool(registry, options);
    await registerFileWriteTool(registry, options);
    await registerFilePatchTool(registry, options);
    await registerHashlineEditTool(registry, options);
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        requirePermissionForAllowlisted: true,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    return registry;
}
