import type {
    AgentEvent,
    ApprovalRecord,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    ToolCall,
} from '@mission-control/protocol';
import type { DesktopApprovalEffectOutcome } from './desktop-approval-effect';
import { sessionEvent, toolFailed } from './desktop-tool-approval-events';
import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    registerCommandRunTool,
} from './tools/command-run';
import { registerFileEditTool } from './tools/file-edit';
import { registerFilePatchTool } from './tools/file-patch';
import { registerFileWriteTool } from './tools/file-write';
import { ToolRegistry } from './tools/tool-registry';

export async function executeApprovedDesktopTool(input: {
    readonly append: (event: AgentEvent) => Promise<void>;
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly toolCall: ToolCall;
    readonly record: ApprovalRecord;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
}): Promise<DesktopApprovalEffectOutcome> {
    const registry = new ToolRegistry();
    await registerFileEditTool(registry, {
        workspaceRoot: input.workspaceRoot,
        requestPermission: permissionResolver(input.record),
    });
    await registerFileWriteTool(registry, {
        workspaceRoot: input.workspaceRoot,
        requestPermission: permissionResolver(input.record),
    });
    await registerFilePatchTool(registry, {
        workspaceRoot: input.workspaceRoot,
        requestPermission: permissionResolver(input.record),
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: input.workspaceRoot,
        requestPermission: permissionResolver(input.record),
        requirePermissionForAllowlisted: true,
        ...(input.commandExecutor !== undefined ? { executor: input.commandExecutor } : {}),
    });
    const advertisement = registry.advertise().find((tool) => tool.name === input.toolCall.toolName);
    if (advertisement === undefined) {
        await input.append(
            toolFailed(input.sessionId, input.toolCall.toolCallId, `unknown tool: ${input.toolCall.toolName}`),
        );
        return 'failed';
    }
    const settlement = await registry.invoke({
        toolCallId: input.toolCall.toolCallId,
        toolName: input.toolCall.toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: input.toolCall.argumentsJson,
    });
    for (const event of settlement.events) {
        await input.append(sessionEvent(event, input.sessionId, input.modelProviderSelection));
    }
    return settlement.result.status === 'completed' ? 'completed' : 'failed';
}

function permissionResolver(record: ApprovalRecord): (request: PermissionRequest) => PermissionDecision {
    return (request) => {
        if (record.subject.kind === 'tool' && request.id === record.requestId && request.action === record.subject.id) {
            return {
                requestId: request.id,
                status: 'allow',
                ...(record.reason !== undefined ? { reason: record.reason } : {}),
            };
        }
        return { requestId: request.id, status: 'deny', reason: 'desktop approval did not authorize this request' };
    };
}
