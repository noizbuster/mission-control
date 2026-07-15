import type { AgentEvent, ApprovalLifecycleState, RunCoordinatorState } from '@mission-control/protocol';

type JsonMachineToolState = {
    readonly toolCallId: string;
    readonly toolName?: string;
    readonly status: 'pending' | 'completed' | 'failed';
};

type JsonMachineApprovalState = {
    readonly approvalId: string;
    readonly state: ApprovalLifecycleState;
    readonly toolCallId?: string;
    readonly resumable: boolean;
};

type JsonMachineRunState = {
    readonly runId?: string;
    readonly status: RunCoordinatorState;
    readonly toolCallId?: string;
};

type JsonMachineState = {
    readonly session: { readonly sessionId: string; readonly stopped: boolean };
    readonly run?: JsonMachineRunState;
    readonly tool?: JsonMachineToolState;
    readonly approval?: JsonMachineApprovalState;
};

export type JsonOutputRecord = AgentEvent & {
    readonly status: RunCoordinatorState;
    readonly runId?: string;
    readonly toolCallId?: string;
    readonly approvalId?: string;
    readonly machine: JsonMachineState;
};

export class JsonMachineStateTracker {
    private sessionId = 'unknown';
    private currentStatus: RunCoordinatorState = 'idle';
    private runState: JsonMachineRunState | undefined;
    private toolState: JsonMachineToolState | undefined;
    private approvalState: JsonMachineApprovalState | undefined;
    private blockedApprovalState: JsonMachineApprovalState | undefined;
    private readonly toolNames = new Map<string, string>();

    recordFor(event: AgentEvent): JsonOutputRecord {
        this.observe(event);
        const approvalId = this.approvalState?.approvalId;
        const toolCallId = this.runState?.toolCallId ?? this.toolState?.toolCallId ?? this.approvalState?.toolCallId;
        return {
            ...event,
            status: this.currentStatus,
            ...(this.runState?.runId !== undefined ? { runId: this.runState.runId } : {}),
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            ...(approvalId !== undefined ? { approvalId } : {}),
            machine: {
                session: { sessionId: this.sessionId, stopped: event.type === 'session.stopped' },
                ...(this.runState !== undefined ? { run: this.runState } : {}),
                ...(this.toolState !== undefined ? { tool: this.toolState } : {}),
                ...(this.approvalState !== undefined ? { approval: this.approvalState } : {}),
            },
        };
    }

    private observe(event: AgentEvent): void {
        if (event.sessionId !== undefined) {
            this.sessionId = event.sessionId;
        }
        const providerChunk = event.providerStreamChunk;
        if (providerChunk?.kind === 'tool_call_completed') {
            this.toolNames.set(providerChunk.toolCall.toolCallId, providerChunk.toolCall.toolName);
            this.toolState = {
                toolCallId: providerChunk.toolCall.toolCallId,
                toolName: providerChunk.toolCall.toolName,
                status: 'pending',
            };
        }
        if (event.toolResult !== undefined) {
            const toolName = this.toolNames.get(event.toolResult.toolCallId);
            this.toolState = {
                toolCallId: event.toolResult.toolCallId,
                ...(toolName !== undefined ? { toolName } : {}),
                status: event.toolResult.status === 'completed' ? 'completed' : 'failed',
            };
        }
        if (event.approvalRecord !== undefined) {
            const toolCallId = toolCallIdFromApproval(event);
            const approvalState: JsonMachineApprovalState = {
                approvalId: event.approvalRecord.approvalId,
                state: event.approvalRecord.state,
                ...(toolCallId !== undefined ? { toolCallId } : {}),
                resumable: event.approvalRecord.state === 'pending',
            };
            if (approvalState.state === 'pending') {
                this.blockedApprovalState = approvalState;
                this.approvalState = approvalState;
                return;
            }
            if (this.currentStatus === 'blocked_on_approval' && this.blockedApprovalState !== undefined) {
                this.approvalState = this.blockedApprovalState;
                return;
            }
            this.approvalState = approvalState;
        }
        if (event.run?.state !== undefined) {
            this.currentStatus = event.run.state;
            this.runState = {
                ...(event.run.runId !== undefined ? { runId: event.run.runId } : {}),
                status: event.run.state,
                ...(event.run.toolCallId !== undefined ? { toolCallId: event.run.toolCallId } : {}),
            };
            if (event.run.state === 'blocked_on_approval' && this.blockedApprovalState !== undefined) {
                this.approvalState = this.blockedApprovalState;
            }
            if (event.run.state !== 'blocked_on_approval') {
                this.blockedApprovalState = undefined;
            }
        }
    }
}

function toolCallIdFromApproval(event: AgentEvent): string | undefined {
    const requestId = event.approvalRecord?.requestId;
    if (requestId?.startsWith('permission_') === true) {
        return requestId.slice('permission_'.length);
    }
    if (event.approvalRecord?.subject.kind !== 'tool') {
        return undefined;
    }
    return event.approvalRecord.subject.id;
}
