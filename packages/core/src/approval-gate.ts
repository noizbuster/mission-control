import type {
    AgentEvent,
    ApprovalRecord,
    PermissionDecision,
    PermissionReply,
    PermissionRequest,
    PermissionRule,
} from '@mission-control/protocol';
import {
    emitApprovalEvent,
    emitPermissionRequestedEvent,
    emitReplyEvent,
    type PermissionGateContext,
} from './approval-gate-events.js';
import {
    type ApprovalEventType,
    approvalIdFor,
    approvalRecord,
    approvedApprovalRecord,
    blockedApprovalRecord,
    errorCodeFor,
    permissionError,
    replyForApprovalState,
} from './approval-gate-helpers.js';
import { PermissionSession } from './permission/session.js';
import { PermissionRuleStore } from './permission/store.js';

export type PermissionDecisionResolver = (
    request: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

export type PendingApprovalBehavior = 'wait' | 'block';
export type ApprovalTerminalState = 'approved' | 'denied' | 'expired' | 'cancelled';

export type ApprovalUpdateInput = {
    readonly approvalId: string;
    readonly state: ApprovalTerminalState;
    readonly reason?: string;
};

export type PendingPermissionApproval = {
    readonly approvalId: string;
    readonly request: PermissionRequest;
    readonly record: ApprovalRecord;
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

type PermissionGateOptions = {
    readonly resolveDecision?: PermissionDecisionResolver;
    readonly emit: (event: AgentEvent) => void;
    readonly now: () => string;
    readonly pendingApprovalBehavior?: PendingApprovalBehavior;
    readonly rules?: readonly PermissionRule[];
    readonly persistedRuleStore?: PermissionRuleStore;
};

type PendingApproval = {
    readonly request: PermissionRequest;
    readonly record: ApprovalRecord;
    readonly context: PermissionGateContext;
    readonly resolve: (decision: PermissionDecision) => void;
    readonly reject: (error: PermissionGateError) => void;
};

export class PermissionGate {
    private readonly resolveDecision: PermissionDecisionResolver | undefined;
    private readonly emit: (event: AgentEvent) => void;
    private readonly now: () => string;
    private readonly pendingApprovalBehavior: PendingApprovalBehavior;
    private readonly pendingApprovals = new Map<string, PendingApproval>();
    private readonly permissionSession: PermissionSession;

    constructor(options: PermissionGateOptions) {
        this.resolveDecision = options.resolveDecision;
        this.emit = options.emit;
        this.now = options.now;
        this.pendingApprovalBehavior = options.pendingApprovalBehavior ?? 'wait';
        this.permissionSession = new PermissionSession({
            ...(options.rules !== undefined ? { builtInRules: options.rules } : {}),
            ...(options.persistedRuleStore !== undefined ? { persistedRuleStore: options.persistedRuleStore } : {}),
        });
    }

    async requestPermission(request: PermissionRequest, context: PermissionGateContext): Promise<PermissionDecision> {
        const sessionDecision =
            request.permission === undefined
                ? undefined
                : await this.permissionSession.evaluate(request, context.sessionId);
        const resolved =
            sessionDecision === undefined
                ? ((await this.resolveDecision?.(request)) ?? {
                      requestId: request.id,
                      status: 'requires_approval',
                      reason: request.reason,
                  })
                : sessionDecision.decision.status === 'requires_approval' && this.resolveDecision !== undefined
                  ? await this.resolveDecision(request)
                  : sessionDecision.decision;
        if (sessionDecision !== undefined) {
            this.permissionSession.consumeOnceRules(context.sessionId, sessionDecision.consumeOnceRules);
        }
        emitPermissionRequestedEvent({
            emit: this.emit,
            now: this.now,
            request,
            decision: resolved,
            context,
        });
        if (resolved.status === 'allow') {
            return resolved;
        }
        if (resolved.status === 'deny') {
            const approvalId = approvalIdFor(request.id);
            const timestamp = this.now();
            const record = approvalRecord(request, resolved, approvalId, 'denied', timestamp, timestamp);
            this.emitApproval('approval.blocked', record, `approval blocked: ${request.action}`, context);
            throw permissionError('permission_denied', request.id, approvalId, resolved.reason ?? request.reason);
        }
        return this.pendingApprovalBehavior === 'block'
            ? this.blockRequiredApproval(request, resolved, context)
            : this.waitForApproval(request, resolved, context);
    }

    listPendingApprovals(): readonly PendingPermissionApproval[] {
        return [...this.pendingApprovals.values()].map((pending) => ({
            approvalId: pending.record.approvalId,
            request: pending.request,
            record: pending.record,
        }));
    }

    async replyToApproval(input: PermissionReply): Promise<void> {
        const pending = this.takePendingApproval(input.approvalId, input);
        emitReplyEvent({
            emit: this.emit,
            now: this.now,
            type: 'permission.replied',
            reply: input,
            context: pending.context,
        });
        await this.permissionSession.rememberReply(pending.request, pending.context.sessionId, input);
        if (input.reply === 'deny') {
            const blocked = this.settleBlockedApproval(pending, 'denied', input.reason);
            pending.reject(blocked);
            return;
        }
        const record = approvedApprovalRecord(pending, this.now(), input.reason);
        this.emitApproval('approval.updated', record, 'approval updated: approved', pending.context);
        this.emitApproval('approval.resumed', record, 'approval resumed', pending.context);
        pending.resolve({
            requestId: pending.request.id,
            status: 'allow',
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
    }

    updateApproval(input: ApprovalUpdateInput): void {
        const pending = this.takePendingApproval(input.approvalId, {
            approvalId: input.approvalId,
            reply: replyForApprovalState(input.state),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
        if (input.state === 'approved') {
            const record = approvedApprovalRecord(pending, this.now(), input.reason);
            this.emitApproval('approval.updated', record, 'approval updated: approved', pending.context);
            this.emitApproval('approval.resumed', record, 'approval resumed', pending.context);
            pending.resolve({
                requestId: pending.request.id,
                status: 'allow',
                ...(input.reason !== undefined ? { reason: input.reason } : {}),
            });
            return;
        }
        pending.reject(this.settleBlockedApproval(pending, input.state, input.reason));
    }

    private waitForApproval(request: PermissionRequest, decision: PermissionDecision, context: PermissionGateContext) {
        const approvalId = approvalIdFor(request.id);
        const record = approvalRecord(request, decision, approvalId, 'pending', this.now());
        const promise = new Promise<PermissionDecision>((resolve, reject) => {
            this.pendingApprovals.set(approvalId, { request, record, context, resolve, reject });
        });
        this.emitApproval('approval.requested', record, `approval requested: ${request.action}`, context);
        return promise;
    }

    private blockRequiredApproval(
        request: PermissionRequest,
        decision: PermissionDecision,
        context: PermissionGateContext,
    ) {
        const approvalId = approvalIdFor(request.id);
        const requestedAt = this.now();
        const pending = approvalRecord(request, decision, approvalId, 'pending', requestedAt);
        this.emitApproval('approval.requested', pending, `approval requested: ${request.action}`, context);
        const blocked = approvalRecord(request, decision, approvalId, 'cancelled', requestedAt, this.now());
        this.emitApproval('approval.blocked', blocked, `approval blocked: ${request.action}`, context);
        return Promise.reject(
            permissionError('approval_required', request.id, approvalId, decision.reason ?? request.reason),
        );
    }

    private takePendingApproval(approvalId: string, reply: PermissionReply): PendingApproval {
        const pending = this.pendingApprovals.get(approvalId);
        if (pending !== undefined) {
            this.pendingApprovals.delete(approvalId);
            return pending;
        }
        emitReplyEvent({
            emit: this.emit,
            now: this.now,
            type: 'permission.reply_not_found',
            reply,
        });
        throw permissionError('approval_not_found', approvalId, approvalId, `Unknown pending approval: ${approvalId}`);
    }

    private settleBlockedApproval(
        pending: PendingApproval,
        state: Exclude<ApprovalTerminalState, 'approved'>,
        reason?: string,
    ) {
        const record = blockedApprovalRecord(pending, this.now(), state, reason);
        this.emitApproval('approval.updated', record, `approval updated: ${state}`, pending.context);
        this.emitApproval('approval.blocked', record, `approval blocked: ${state}`, pending.context);
        return permissionError(errorCodeFor(state), pending.request.id, pending.record.approvalId, record.reason);
    }

    private emitApproval(
        type: ApprovalEventType,
        record: ApprovalRecord,
        message: string,
        context: PermissionGateContext,
    ): void {
        emitApprovalEvent({
            emit: this.emit,
            now: this.now,
            type,
            record,
            message,
            context,
        });
    }
}
