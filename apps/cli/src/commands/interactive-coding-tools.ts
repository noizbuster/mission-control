import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createReadOnlyRepoToolRegistrations,
    registerBashRunTool,
    registerCommandRunTool,
    registerFileEditTool,
    registerFilePatchTool,
    registerFileWriteTool,
    type ToolInvocationSettlement,
    ToolRegistry,
} from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { type AgentEvent, type PermissionRequest, type ToolCall, ToolResultSchema } from '@mission-control/protocol';
import { cliAllowsAction } from './cli-permission-policy.js';
import type { InteractiveApprovalBroker } from './interactive-approval-broker.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { renderToolPreview } from './interactive-coding-tool-preview.js';

export type InteractiveToolOptions = {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly enableTrustedBash?: boolean;
};

export async function createInteractiveToolRegistry(
    options: InteractiveToolOptions,
    approvals: InteractiveApprovalBroker,
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const readTools = await createReadOnlyRepoToolRegistrations({
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    registry.register(readTools[3]);
    registry.register(readTools[4]);
    registry.register(readTools[5]);
    registry.register(readTools[6]);
    await registerFileEditTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerFileWriteTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerFilePatchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    if (options.enableTrustedBash === true && cliAllowsAction('bash.run')) {
        await registerBashRunTool(registry, {
            workspaceRoot: options.workspaceRoot,
            workspaceTrust: 'trusted',
            requestPermission: approvals.requestPermission,
            ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
        });
    }
    return registry;
}

export async function preflightInteractiveToolCall(
    toolCall: ToolCall,
    options: InteractiveToolOptions,
    approvals: InteractiveApprovalBroker,
): Promise<ToolInvocationSettlement | undefined> {
    if (toolCall.toolName === 'file.write' && parseFileWritePreview(toolCall.argumentsJson) === undefined) {
        return undefined;
    }
    await renderToolPreview(toolCall, options.output, options.workspaceRoot);
    const request = approvalRequestForToolCall(toolCall, options.workspaceRoot);
    if (request === undefined) {
        return undefined;
    }
    const decision = await approvals.requestPermission(request);
    if (decision.status === 'allow') {
        approvals.primeApproval(request.id, decision.reason);
        return undefined;
    }
    const messagePrefix = decision.status === 'deny' ? 'approval_denied' : 'approval_required';
    const message = `${messagePrefix}: ${decision.reason ?? 'interactive CLI approval'}`;
    const result = ToolResultSchema.parse({
        toolCallId: toolCall.toolCallId,
        status: 'failed',
        error: {
            code: 'tool_failed',
            message,
            retryable: false,
        },
    });
    return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result,
        events: [
            {
                type: 'tool.failed',
                timestamp: new Date().toISOString(),
                taskId: toolCall.toolCallId,
                message: `tool failed: ${toolCall.toolName}`,
                nativeSidecarStatus: 'mock',
                modelProviderSelection: options.modelProviderSelection,
                toolResult: result,
            },
        ],
    };
}

function approvalRequestForToolCall(toolCall: ToolCall, workspaceRoot: string): PermissionRequest | undefined {
    if (toolCall.toolName === 'command.run') {
        const input = parseCommandRunPreview(toolCall.argumentsJson);
        if (input === undefined) {
            return undefined;
        }
        const command = [input.command, ...input.args].join(' ');
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'command.run',
            reason: `run command: ${command}`,
            permission: {
                kind: 'bash',
                patterns: [command],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'bash.run') {
        const input = parseBashRunPreview(toolCall.argumentsJson);
        if (input === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'bash.run',
            reason: `run trusted bash: ${input.commandLine}`,
            permission: {
                kind: 'bash',
                patterns: [input.commandLine],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'file.edit') {
        const input = parseFileEditPreview(toolCall.argumentsJson);
        if (input === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'file.edit',
            reason: `edit exact text in ${input.path}`,
            permission: {
                kind: 'edit',
                patterns: [input.path],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'file.patch') {
        const patch = parsePatchPreview(toolCall.argumentsJson);
        const paths = patch === undefined ? [] : patchTargetPaths(patch);
        if (paths.length === 0) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'file.patch',
            reason: `apply patch to ${paths.join(', ')}`,
            permission: {
                kind: 'patch',
                patterns: [...paths],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'file.write') {
        const input = parseFileWritePreview(toolCall.argumentsJson);
        if (input === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'file.write',
            reason:
                input.createParents === true
                    ? `write full contents to ${input.path} and create parent directories`
                    : `write full contents to ${input.path}`,
            permission: {
                kind: 'write',
                patterns: [input.path],
                workspaceRoot,
            },
        };
    }
    return undefined;
}

function parseCommandRunPreview(
    argumentsJson: string,
): { readonly command: string; readonly args: readonly string[] } | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.command !== 'string' || value.command.length === 0) {
        return undefined;
    }
    const args = value.args;
    if (args === undefined) {
        return { command: value.command, args: [] };
    }
    if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) {
        return undefined;
    }
    return { command: value.command, args: [...args] };
}

function parsePatchPreview(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    return isRecord(value) && typeof value.patch === 'string' && value.patch.length > 0 ? value.patch : undefined;
}

function parseBashRunPreview(
    argumentsJson: string,
): { readonly commandLine: string; readonly cwd?: string } | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.commandLine !== 'string' || value.commandLine.length === 0) {
        return undefined;
    }
    if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length === 0)) {
        return undefined;
    }
    return {
        commandLine: value.commandLine,
        ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    };
}

function parseFileEditPreview(argumentsJson: string):
    | {
          readonly path: string;
          readonly oldText: string;
          readonly newText: string;
          readonly occurrence?: number;
          readonly replaceAll?: boolean;
      }
    | undefined {
    const value = parseArguments(argumentsJson);
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.oldText !== 'string' ||
        value.oldText.length === 0 ||
        typeof value.newText !== 'string'
    ) {
        return undefined;
    }
    if (value.occurrence !== undefined && !isPositiveInteger(value.occurrence)) {
        return undefined;
    }
    if (value.replaceAll !== undefined && typeof value.replaceAll !== 'boolean') {
        return undefined;
    }
    if (value.occurrence !== undefined && value.replaceAll !== undefined) {
        return undefined;
    }
    if (value.oldText === value.newText) {
        return undefined;
    }
    return {
        path: value.path,
        oldText: value.oldText,
        newText: value.newText,
        ...(value.occurrence !== undefined ? { occurrence: value.occurrence } : {}),
        ...(value.replaceAll !== undefined ? { replaceAll: value.replaceAll } : {}),
    };
}

function parseFileWritePreview(
    argumentsJson: string,
): { readonly path: string; readonly content: string; readonly createParents: boolean } | undefined {
    const value = parseArguments(argumentsJson);
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.content !== 'string'
    ) {
        return undefined;
    }
    if (value.createParents !== undefined && typeof value.createParents !== 'boolean') {
        return undefined;
    }
    if (isBinaryWriteContent(value.content)) {
        return undefined;
    }
    return {
        path: value.path,
        content: value.content,
        createParents: value.createParents === true,
    };
}

function isBinaryWriteContent(content: string): boolean {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length === 0) {
        return false;
    }
    let suspicious = 0;
    for (const byte of bytes) {
        if (byte === 0) {
            return true;
        }
        if (byte < 9 || (byte > 13 && byte < 32)) {
            suspicious += 1;
        }
    }
    return suspicious / bytes.length > 0.3;
}

function patchTargetPaths(patch: string): readonly string[] {
    const paths = new Set<string>();
    for (const line of patch.split('\n')) {
        const diffMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line);
        if (diffMatch?.[1] !== undefined) {
            paths.add(diffMatch[1]);
            continue;
        }
        const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fileMatch?.[1] !== undefined) {
            paths.add(fileMatch[1]);
        }
    }
    return [...paths];
}

function parseArguments(argumentsJson: string): unknown {
    try {
        return JSON.parse(argumentsJson);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is {
    readonly args?: unknown;
    readonly command?: unknown;
    readonly content?: unknown;
    readonly cwd?: unknown;
    readonly createParents?: unknown;
    readonly commandLine?: unknown;
    readonly newText?: unknown;
    readonly occurrence?: unknown;
    readonly oldText?: unknown;
    readonly patch?: unknown;
    readonly path?: unknown;
    readonly replaceAll?: unknown;
} {
    return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
