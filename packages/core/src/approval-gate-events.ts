import type {
    AgentEvent,
    ApprovalRecord,
    ModelProviderSelection,
    PermissionDecision,
    PermissionReply,
    PermissionRequest,
} from '@mission-control/protocol';
import type { ApprovalEventType } from './approval-gate-helpers.js';

export type PermissionGateContext = {
    readonly sessionId: string;
    readonly taskId?: string;
    readonly modelProviderSelection: ModelProviderSelection;
};

export function emitPermissionRequestedEvent(input: {
    readonly emit: (event: AgentEvent) => void;
    readonly now: () => string;
    readonly request: PermissionRequest;
    readonly decision: PermissionDecision;
    readonly context: PermissionGateContext;
}): void {
    input.emit({
        type: 'permission.requested',
        timestamp: input.now(),
        sessionId: input.context.sessionId,
        ...(input.context.taskId !== undefined ? { taskId: input.context.taskId } : {}),
        message: `permission requested: ${input.request.action}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.context.modelProviderSelection,
        permissionRequest: input.request,
        permissionDecision: input.decision,
    });
}

export function emitApprovalEvent(input: {
    readonly emit: (event: AgentEvent) => void;
    readonly now: () => string;
    readonly type: ApprovalEventType;
    readonly record: ApprovalRecord;
    readonly message: string;
    readonly context: PermissionGateContext;
}): void {
    input.emit({
        type: input.type,
        timestamp: input.now(),
        sessionId: input.context.sessionId,
        ...(input.context.taskId !== undefined ? { taskId: input.context.taskId } : {}),
        message: input.message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.context.modelProviderSelection,
        approvalRecord: input.record,
    });
}

export function emitReplyEvent(input: {
    readonly emit: (event: AgentEvent) => void;
    readonly now: () => string;
    readonly type: Extract<AgentEvent['type'], 'permission.replied' | 'permission.reply_not_found'>;
    readonly reply: PermissionReply;
    readonly context?: PermissionGateContext;
}): void {
    input.emit({
        type: input.type,
        timestamp: input.now(),
        ...(input.context?.sessionId !== undefined ? { sessionId: input.context.sessionId } : {}),
        ...(input.context?.taskId !== undefined ? { taskId: input.context.taskId } : {}),
        message:
            input.type === 'permission.replied'
                ? `permission replied: ${input.reply.reply}`
                : `permission reply not found: ${input.reply.approvalId}`,
        nativeSidecarStatus: 'mock',
        ...(input.context !== undefined ? { modelProviderSelection: input.context.modelProviderSelection } : {}),
        permissionReply: input.reply,
    });
}
