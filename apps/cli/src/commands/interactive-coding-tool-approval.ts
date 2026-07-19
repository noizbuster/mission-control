import type { ToolInvocationSettlement } from '@mission-control/core';
import type { ModelProviderSelection, PermissionKind, PermissionRequest, ToolCall } from '@mission-control/protocol';
import { ToolResultSchema } from '@mission-control/protocol';
import { sanitizeTerminalDisplayText } from '@mission-control/tui/state';
import type { InteractiveApprovalBroker } from './interactive-approval-broker';
import {
    FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES,
    prepareFileWriteArgumentsPreview,
} from './interactive-coding-file-write-preview';
import { renderToolPreview } from './interactive-coding-tool-preview';
import {
    parseBashRunPreview,
    parseCommandRunPreview,
    parseFileEditPreview,
    parseFileWritePreview,
    parseHashlineEditPreview,
    parsePatchPreview,
    parseTaskDescription,
    parseWebfetchUrl,
    parseWebSearchQuery,
    patchTargetPaths,
} from './interactive-coding-tool-previews';
import type { InteractiveToolOptions } from './interactive-coding-tools';
import type { ProviderRenderState } from './interactive-coding-transcript-render-state';

export async function preflightInteractiveToolCall(
    toolCall: ToolCall,
    options: InteractiveToolOptions & {
        readonly executionTurnId: string;
        readonly renderState: ProviderRenderState;
    },
    approvals: InteractiveApprovalBroker,
): Promise<ToolInvocationSettlement | undefined> {
    if (toolCall.toolName === 'file.write') {
        const argumentsPreview = prepareFileWriteArgumentsPreview(toolCall.argumentsJson);
        if (argumentsPreview.kind === 'raw') {
            return failedToolSettlement(
                toolCall,
                options.modelProviderSelection,
                `file_write_arguments_too_large: maximum ${FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES} bytes`,
            );
        }
        if (parseFileWritePreview(toolCall.argumentsJson) === undefined) return undefined;
    }
    await renderToolPreview(toolCall, options.output, {
        state: options.renderState,
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
    });
    if (toolCall.toolName === 'task') {
        const description = parseTaskDescription(toolCall.argumentsJson);
        if (description !== undefined) {
            options.output.showNotice?.(`Task: ${sanitizeTerminalDisplayText(description)}`);
        }
    }
    const request = approvalRequestForToolCall(toolCall, options.workspaceRoot);
    if (request === undefined) return undefined;
    const decision = await approvals.requestPermission(request);
    if (decision.status === 'allow') {
        approvals.primeApproval(request, decision.reason);
        return undefined;
    }
    const messagePrefix = decision.status === 'deny' ? 'approval_denied' : 'approval_required';
    return failedToolSettlement(
        toolCall,
        options.modelProviderSelection,
        `${messagePrefix}: ${decision.reason ?? 'interactive CLI approval'}`,
    );
}

function failedToolSettlement(
    toolCall: ToolCall,
    modelProviderSelection: ModelProviderSelection,
    message: string,
): ToolInvocationSettlement {
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
                modelProviderSelection,
                toolResult: result,
            },
        ],
    };
}

function approvalRequestForToolCall(toolCall: ToolCall, workspaceRoot: string): PermissionRequest | undefined {
    const permission = permissionTarget(toolCall);
    if (permission === undefined) return undefined;
    return {
        id: `permission_${toolCall.toolCallId}`,
        action: permission.action,
        reason: permission.reason,
        permission: { kind: permission.kind, patterns: [...permission.patterns], workspaceRoot },
    };
}

type PermissionTarget = {
    readonly action: string;
    readonly reason: string;
    readonly kind: PermissionKind;
    readonly patterns: readonly string[];
};

function permissionTarget(toolCall: ToolCall): PermissionTarget | undefined {
    if (toolCall.toolName.startsWith('mcp__')) {
        return {
            action: 'mcp',
            reason: `MCP tool: ${toolCall.toolName}`,
            kind: 'network',
            patterns: [toolCall.toolName],
        };
    }
    if (toolCall.toolName === 'webfetch') {
        const url = parseWebfetchUrl(toolCall.argumentsJson);
        return url === undefined
            ? undefined
            : { action: 'webfetch', reason: `fetch url: ${url}`, kind: 'network', patterns: [url] };
    }
    if (toolCall.toolName === 'web_search') {
        const query = parseWebSearchQuery(toolCall.argumentsJson);
        return query === undefined
            ? undefined
            : { action: 'web_search', reason: `web search query: ${query}`, kind: 'network', patterns: [query] };
    }
    if (toolCall.toolName === 'task') {
        const description = parseTaskDescription(toolCall.argumentsJson);
        return description === undefined
            ? undefined
            : {
                  action: 'task',
                  reason: `delegate sub-task: ${description}`,
                  kind: 'subagent',
                  patterns: [description],
              };
    }
    if (toolCall.toolName === 'command.run') {
        const input = parseCommandRunPreview(toolCall.argumentsJson);
        const command = input === undefined ? undefined : [input.command, ...input.args].join(' ');
        return command === undefined
            ? undefined
            : { action: 'command.run', reason: `run command: ${command}`, kind: 'bash', patterns: [command] };
    }
    if (toolCall.toolName === 'bash.run') {
        const input = parseBashRunPreview(toolCall.argumentsJson);
        return input === undefined
            ? undefined
            : {
                  action: 'bash.run',
                  reason: `run trusted bash: ${input.commandLine}`,
                  kind: 'bash',
                  patterns: [input.commandLine],
              };
    }
    if (toolCall.toolName === 'eval') {
        return {
            action: 'eval',
            reason: 'execute JavaScript or Python code in local runtimes',
            kind: 'bash',
            patterns: ['eval'],
        };
    }
    if (toolCall.toolName === 'file.edit') {
        const input = parseFileEditPreview(toolCall.argumentsJson);
        return input === undefined
            ? undefined
            : { action: 'file.edit', reason: `edit exact text in ${input.path}`, kind: 'edit', patterns: [input.path] };
    }
    if (toolCall.toolName === 'hashline_edit') {
        const input = parseHashlineEditPreview(toolCall.argumentsJson);
        return input === undefined
            ? undefined
            : {
                  action: 'hashline_edit',
                  reason: `hashline edit in ${input.path}`,
                  kind: 'edit',
                  patterns: [input.path],
              };
    }
    if (toolCall.toolName === 'file.patch') {
        const patch = parsePatchPreview(toolCall.argumentsJson);
        const paths = patch === undefined ? [] : patchTargetPaths(patch);
        return paths.length === 0
            ? undefined
            : { action: 'file.patch', reason: `apply patch to ${paths.join(', ')}`, kind: 'patch', patterns: paths };
    }
    if (toolCall.toolName === 'file.write') {
        const input = parseFileWritePreview(toolCall.argumentsJson);
        if (input === undefined) return undefined;
        return {
            action: 'file.write',
            reason: input.createParents
                ? `write full contents to ${input.path} and create parent directories`
                : `write full contents to ${input.path}`,
            kind: 'write',
            patterns: [input.path],
        };
    }
    return undefined;
}
