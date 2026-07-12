import type { ToolCall } from '@mission-control/protocol';
import { resolve } from 'node:path';

export type DesktopApprovalEffect = {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly argumentsJson: string;
    readonly workspaceRoot: string;
};

export function desktopApprovalEffect(input: {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly runId: string;
    readonly toolCall: ToolCall;
    readonly workspaceRoot: string;
}): DesktopApprovalEffect {
    return {
        sessionId: input.sessionId,
        approvalId: input.approvalId,
        runId: input.runId,
        toolCallId: input.toolCall.toolCallId,
        toolName: input.toolCall.toolName,
        argumentsJson: input.toolCall.argumentsJson,
        workspaceRoot: resolve(input.workspaceRoot),
    };
}

export function sameDesktopApprovalEffect(left: DesktopApprovalEffect, right: DesktopApprovalEffect): boolean {
    return (
        left.sessionId === right.sessionId &&
        left.approvalId === right.approvalId &&
        left.runId === right.runId &&
        left.toolCallId === right.toolCallId &&
        left.toolName === right.toolName &&
        left.argumentsJson === right.argumentsJson &&
        left.workspaceRoot === right.workspaceRoot
    );
}
