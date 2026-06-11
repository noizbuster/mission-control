import type {
    AgentEvent,
    ApprovalRecord,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';

export type PermissionDecisionResolver = (
    request: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

export type PendingApprovalBehavior = 'wait' | 'block';
export type ApprovalTerminalState = 'approved' | 'denied' | 'expired' | 'cancelled';
type BlockedApprovalState = Exclude<ApprovalTerminalState, 'approved'>;
type ApprovalEventType = Extract<
    AgentEvent['type'],
    'approval.requested' | 'approval.updated' | 'approval.blocked' | 'approval.resumed'
>;

export type ApprovalUpdateInput = {
    readonly approvalId: string;
    readonly state: ApprovalTerminalState;
    readonly reason?: string;
};

export class PermissionGateError extends Error {
    readonly code:
        | 'permission_denied'
        | 'approval_denied'
        | 'approval_expired'
        | 'approval_cancelled'
        | 'approval_required'
        | 'approval_not_found';
    readonly requestId: string;
    readonly approvalId: string;

    constructor(input: {
        readonly code: PermissionGateError['code'];
        readonly requestId: string;
        readonly approvalId: string;
        readonly message: string;
    }) {
        super(input.message);
        this.name = 'PermissionGateError';
        this.code = input.code;
        this.requestId = input.requestId;
        this.approvalId = input.approvalId;
    }
}

type PermissionGateContext = {
    readonly sessionId: string;
    readonly taskId?: string;
    readonly modelProviderSelection: ModelProviderSelection;
};

type PermissionGateOptions = {
    readonly resolveDecision: PermissionDecisionResolver;
    readonly emit: (event: AgentEvent) => void;
    readonly now: () => string;
    readonly pendingApprovalBehavior?: PendingApprovalBehavior;
};

type PendingApproval = {
    readonly request: PermissionRequest;
    readonly decision: PermissionDecision;
    readonly record: ApprovalRecord;
    readonly context: PermissionGateContext;
    readonly resolve: (decision: PermissionDecision) => void;
    readonly reject: (error: PermissionGateError) => void;
};

export class PermissionGate {
    private readonly resolveDecision: PermissionDecisionResolver;
    private readonly emit: (event: AgentEvent) => void;
    private readonly now: () => string;
    private readonly pendingApprovalBehavior: PendingApprovalBehavior;
    private readonly pendingApprovals = new Map<string, PendingApproval>();

    constructor(options: PermissionGateOptions) {
        this.resolveDecision = options.resolveDecision;
        this.emit = options.emit;
        this.now = options.now;
        this.pendingApprovalBehavior = options.pendingApprovalBehavior ?? 'wait';
    }

    async requestPermission(request: PermissionRequest, context: PermissionGateContext): Promise<PermissionDecision> {
        const decision = await this.resolveDecision(request);
        this.emitPermissionRequested(request, decision, context);
        if (decision.status === 'allow') {
            return decision;
        }
        if (decision.status === 'deny') {
            const approvalId = approvalIdFor(request.id);
            const timestamp = this.now();
            const record = approvalRecord(request, decision, approvalId, 'denied', timestamp, timestamp);
            this.emitApproval('approval.blocked', record, `approval blocked: ${request.action}`, context);
            throw permissionError('permission_denied', request.id, approvalId, decision.reason ?? request.reason);
        }
        if (this.pendingApprovalBehavior === 'block') {
            return this.blockRequiredApproval(request, decision, context);
        }
        return this.waitForApproval(request, decision, context);
    }

    updateApproval(input: ApprovalUpdateInput): void {
        const pending = this.pendingApprovals.get(input.approvalId);
        if (pending === undefined) {
            throw permissionError(
                'approval_not_found',
                input.approvalId,
                input.approvalId,
                `Unknown pending approval: ${input.approvalId}`,
            );
        }
        this.pendingApprovals.delete(input.approvalId);
        const timestamp = this.now();
        const record = {
            ...pending.record,
            state: input.state,
            decidedAt: timestamp,
            reason: input.reason ?? pending.record.reason,
        } satisfies ApprovalRecord;
        this.emitApproval('approval.updated', record, `approval updated: ${input.state}`, pending.context);
        if (input.state === 'approved') {
            this.emitApproval('approval.resumed', record, 'approval resumed', pending.context);
            pending.resolve({
                requestId: pending.request.id,
                status: 'allow',
                ...(input.reason !== undefined ? { reason: input.reason } : {}),
            });
            return;
        }
        this.emitApproval('approval.blocked', record, `approval blocked: ${input.state}`, pending.context);
        pending.reject(permissionError(errorCodeFor(input.state), pending.request.id, input.approvalId, record.reason));
    }

    private waitForApproval(
        request: PermissionRequest,
        decision: PermissionDecision,
        context: PermissionGateContext,
    ): Promise<PermissionDecision> {
        const approvalId = approvalIdFor(request.id);
        const timestamp = this.now();
        const record = approvalRecord(request, decision, approvalId, 'pending', timestamp);
        const promise = new Promise<PermissionDecision>((resolve, reject) => {
            this.pendingApprovals.set(approvalId, { request, decision, record, context, resolve, reject });
        });
        this.emitApproval('approval.requested', record, `approval requested: ${request.action}`, context);
        return promise;
    }

    private blockRequiredApproval(
        request: PermissionRequest,
        decision: PermissionDecision,
        context: PermissionGateContext,
    ): Promise<PermissionDecision> {
        const approvalId = approvalIdFor(request.id);
        const requestedAt = this.now();
        const pending = approvalRecord(request, decision, approvalId, 'pending', requestedAt);
        this.emitApproval('approval.requested', pending, `approval requested: ${request.action}`, context);
        const decidedAt = this.now();
        const blocked = approvalRecord(request, decision, approvalId, 'cancelled', requestedAt, decidedAt);
        this.emitApproval('approval.blocked', blocked, `approval blocked: ${request.action}`, context);
        return Promise.reject(
            permissionError('approval_required', request.id, approvalId, decision.reason ?? request.reason),
        );
    }

    private emitPermissionRequested(
        request: PermissionRequest,
        decision: PermissionDecision,
        context: PermissionGateContext,
    ): void {
        this.emit({
            type: 'permission.requested',
            timestamp: this.now(),
            sessionId: context.sessionId,
            ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
            message: `permission requested: ${request.action}`,
            nativeSidecarStatus: 'mock',
            modelProviderSelection: context.modelProviderSelection,
            permissionRequest: request,
            permissionDecision: decision,
        });
    }

    private emitApproval(
        type: ApprovalEventType,
        record: ApprovalRecord,
        message: string,
        context: PermissionGateContext,
    ): void {
        this.emit({
            type,
            timestamp: this.now(),
            sessionId: context.sessionId,
            ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
            message,
            nativeSidecarStatus: 'mock',
            modelProviderSelection: context.modelProviderSelection,
            approvalRecord: record,
        });
    }
}

function approvalRecord(
    request: PermissionRequest,
    decision: PermissionDecision,
    approvalId: string,
    state: ApprovalRecord['state'],
    requestedAt: string,
    decidedAt?: string,
): ApprovalRecord {
    return {
        approvalId,
        requestId: request.id,
        policyDecision: decision.status === 'deny' ? 'deny' : 'requires_approval',
        state,
        subject: { kind: 'tool', id: request.action },
        requestedAt,
        ...(decidedAt !== undefined ? { decidedAt } : {}),
        reason: decision.reason ?? request.reason,
    };
}

function approvalIdFor(requestId: string): string {
    return `approval_${requestId}`;
}

function permissionError(
    code: PermissionGateError['code'],
    requestId: string,
    approvalId: string,
    reason = 'permission blocked',
): PermissionGateError {
    return new PermissionGateError({ code, requestId, approvalId, message: reason });
}

function errorCodeFor(state: BlockedApprovalState): PermissionGateError['code'] {
    switch (state) {
        case 'denied':
            return 'approval_denied';
        case 'expired':
            return 'approval_expired';
        case 'cancelled':
            return 'approval_cancelled';
    }
}
