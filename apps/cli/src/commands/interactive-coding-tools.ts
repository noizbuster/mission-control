import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    registerCommandRunTool,
    registerFilePatchTool,
    ToolRegistry,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
import type { InteractiveApprovalBroker } from './interactive-approval-broker.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { parseFilePatchOutput, renderToolPreview } from './interactive-coding-tool-preview.js';

export type InteractiveToolOptions = {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

export async function createInteractiveToolRegistry(
    options: InteractiveToolOptions,
    approvals: InteractiveApprovalBroker,
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerFilePatchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    return registry;
}

export async function settleInteractiveToolCall(
    registry: ToolRegistry,
    toolCall: ToolCall,
    options: InteractiveToolOptions,
    approvals: InteractiveApprovalBroker,
    signal: AbortSignal,
): Promise<void> {
    renderToolPreview(toolCall, options.output);
    const advertisement = registry.advertise().find((tool) => tool.name === toolCall.toolName);
    if (advertisement === undefined) {
        options.output.write(`Unknown tool: ${toolCall.toolName}\n`);
        return;
    }
    if (toolCall.toolName === 'file.patch' || toolCall.toolName === 'command.run') {
        const decision = await approvals.requestApproval({
            id: `approval_${toolCall.toolCallId}`,
            action: toolCall.toolName,
            reason: `approve ${toolCall.toolName}`,
        });
        if (decision.status !== 'allow') {
            options.output.write(`${toolCall.toolName} failed: approval_denied: ${decision.reason ?? 'denied'}\n`);
            return;
        }
    }
    const settlement = await registry.invoke({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: toolCall.argumentsJson,
        signal,
    });
    for (const event of settlement.events) {
        options.emitEvent(sessionEvent(options, event));
    }
    if (settlement.result.status === 'failed') {
        options.output.write(`${toolCall.toolName} failed: ${settlement.result.error?.message ?? 'unknown error'}\n`);
        return;
    }
    if (toolCall.toolName === 'file.patch') {
        const parsed = parseFilePatchOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            options.output.write(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`);
        }
        return;
    }
    if (toolCall.toolName === 'command.run') {
        options.output.write(`Command output for command.run\n${settlement.modelOutput?.content ?? ''}\n`);
    }
}

function sessionEvent(options: InteractiveToolOptions, event: AgentEvent): AgentEvent {
    return {
        ...event,
        sessionId: options.sessionId,
        modelProviderSelection: event.modelProviderSelection ?? options.modelProviderSelection,
    };
}
