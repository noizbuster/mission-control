import type { AgentEvent, ToolResult } from '@mission-control/protocol';

export function completedToolEvent(toolCallId: string, toolName: string, toolResult: ToolResult): AgentEvent {
    return toolEvent('tool.completed', toolCallId, `tool completed: ${toolName}`, toolResult);
}

export function failedToolEvent(toolCallId: string, toolName: string, toolResult: ToolResult): AgentEvent {
    return toolEvent('tool.failed', toolCallId, `tool failed: ${toolName}`, toolResult);
}

function toolEvent(
    type: 'tool.completed' | 'tool.failed',
    toolCallId: string,
    message: string,
    toolResult: ToolResult,
): AgentEvent {
    return {
        type,
        timestamp: new Date().toISOString(),
        taskId: toolCallId,
        message,
        nativeSidecarStatus: 'mock',
        toolResult,
    };
}
