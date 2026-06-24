import { PermissionRuleStore, PermissionSession } from '@mission-control/core';
import type { ApprovalRecord, PermissionDecision, PermissionReply, PermissionRequest } from '@mission-control/protocol';
import { type ApprovalLevel, approvalLevelRules } from './approval-level.js';
import type { InteractiveToolOptions } from './interactive-coding-tools.js';

export type InteractiveApprovalBroker = {
    readonly requestApproval: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly primeApproval: (requestId: string, reason?: string) => void;
    readonly answer: (line: string) => boolean;
    readonly cancel: (reason: string) => void;
    readonly hasPending: () => boolean;
    readonly setApprovalLevel: (level: ApprovalLevel) => void;
};

type PendingApproval = {
    readonly request: PermissionRequest;
    readonly record: ApprovalRecord;
    readonly resolve: (decision: PermissionDecision) => void;
};

export function createInteractiveApprovalBroker(
    options: InteractiveToolOptions,
    sharedPermissionSession?: PermissionSession,
): InteractiveApprovalBroker {
    // A shared session lets session-scoped "always" approvals survive across prompt turns.
    const permissionSession =
        sharedPermissionSession ??
        new PermissionSession({
            builtInRules: approvalLevelRules(options.approvalLevel ?? 'safe'),
            persistedRuleStore: new PermissionRuleStore(),
        });
    let pending: PendingApproval | undefined;
    let cancelledReason: string | undefined;
    const queuedAnswers: string[] = [];
    const primedApprovals = new Map<string, string | undefined>();

    return {
        requestApproval: (request) =>
            requestPermission(
                options,
                permissionSession,
                request,
                queuedAnswers,
                primedApprovals,
                () => pending,
                () => cancelledReason,
                (next) => {
                    pending = next;
                },
            ),
        requestPermission: (request) =>
            requestPermission(
                options,
                permissionSession,
                request,
                queuedAnswers,
                primedApprovals,
                () => pending,
                () => cancelledReason,
                (next) => {
                    pending = next;
                },
            ),
        primeApproval: (requestId, reason) => {
            primedApprovals.set(requestId, reason);
        },
        answer: (line) => {
            if (pending === undefined) {
                if (!isApprovalAnswer(line)) {
                    return false;
                }
                queuedAnswers.push(line);
                return true;
            }
            const current = pending;
            pending = undefined;
            void resolvePendingApproval(options, permissionSession, current, parseReply(line));
            return true;
        },
        cancel: (reason) => {
            cancelledReason = reason;
            if (pending === undefined) {
                return;
            }
            const current = pending;
            pending = undefined;
            void resolvePendingApproval(options, permissionSession, current, {
                approvalId: approvalIdFor(current.request),
                reply: 'deny',
                reason,
            });
        },
        hasPending: () => pending !== undefined,
        setApprovalLevel: (nextLevel) => {
            permissionSession.replaceBuiltInRules(approvalLevelRules(nextLevel));
        },
    };
}

async function requestPermission(
    options: InteractiveToolOptions,
    permissionSession: PermissionSession,
    request: PermissionRequest,
    queuedAnswers: string[],
    primedApprovals: Map<string, string | undefined>,
    getPending: () => PendingApproval | undefined,
    getCancelledReason: () => string | undefined,
    setPending?: (approval: PendingApproval) => void,
): Promise<PermissionDecision> {
    if (primedApprovals.has(request.id)) {
        const reason = primedApprovals.get(request.id);
        primedApprovals.delete(request.id);
        return {
            requestId: request.id,
            status: 'allow',
            ...(reason !== undefined ? { reason } : {}),
        };
    }
    const evaluated = await permissionSession.evaluate(request, options.sessionId);
    permissionSession.consumeOnceRules(options.sessionId, evaluated.consumeOnceRules);
    if (evaluated.decision.status !== 'requires_approval') {
        return evaluated.decision;
    }
    if (getPending() !== undefined) {
        return {
            requestId: request.id,
            status: 'deny',
            reason: 'another approval is already pending',
        };
    }
    options.emitEvent(eventWithPermission(options, request, evaluated.decision));
    const approval = approvalRecordForRequest(request, evaluated.decision);
    options.emitEvent(
        eventWithApproval(options, 'approval.requested', approval, `approval requested: ${request.action}`),
    );
    options.output.write(`Approve ${request.action}? [once/always/deny]:`);
    options.output.showApproval?.(request.action, request.reason);
    const queuedAnswer = queuedAnswers.shift();
    if (queuedAnswer !== undefined) {
        return resolveQueuedApproval(options, permissionSession, request, approval, parseReply(queuedAnswer));
    }
    const cancelledReason = getCancelledReason();
    if (cancelledReason !== undefined) {
        return resolveQueuedApproval(options, permissionSession, request, approval, {
            approvalId: approvalIdFor(request),
            reply: 'deny',
            reason: cancelledReason,
        });
    }
    return new Promise((resolve) => {
        setPending?.({ request, record: approval, resolve });
    });
}

async function resolvePendingApproval(
    options: InteractiveToolOptions,
    permissionSession: PermissionSession,
    pending: PendingApproval,
    reply: PermissionReply,
): Promise<void> {
    const decision = await resolveQueuedApproval(options, permissionSession, pending.request, pending.record, reply);
    pending.resolve(decision);
}

async function resolveQueuedApproval(
    options: InteractiveToolOptions,
    permissionSession: PermissionSession,
    request: PermissionRequest,
    record: ApprovalRecord,
    reply: PermissionReply,
): Promise<PermissionDecision> {
    const normalizedReply = {
        ...reply,
        approvalId: reply.approvalId.length > 0 ? reply.approvalId : approvalIdFor(request),
    } satisfies PermissionReply;
    await permissionSession.rememberReply(request, options.sessionId, normalizedReply);
    options.output.write('\n');
    options.output.hideApproval?.();
    options.output.write(renderApprovalResult(request.action, normalizedReply.reply, normalizedReply.reason));
    options.emitEvent(eventWithReply(options, normalizedReply));
    const decidedRecord = approvalDecisionRecord(record, normalizedReply);
    options.emitEvent(
        eventWithApproval(options, 'approval.updated', decidedRecord, `approval updated: ${decidedRecord.state}`),
    );
    options.emitEvent(
        eventWithApproval(
            options,
            normalizedReply.reply === 'deny' ? 'approval.blocked' : 'approval.resumed',
            decidedRecord,
            normalizedReply.reply === 'deny' ? `approval blocked: ${decidedRecord.state}` : 'approval resumed',
        ),
    );
    return {
        requestId: request.id,
        status: normalizedReply.reply === 'deny' ? 'deny' : 'allow',
        reason: normalizedReply.reason ?? 'interactive CLI approval',
    };
}

function parseReply(line: string): PermissionReply {
    const answer = line.trim().toLowerCase();
    if (answer === 'a' || answer === 'always') {
        return { approvalId: '', reply: 'always', reason: 'interactive CLI approval', persist: true };
    }
    if (answer === 's' || answer === 'session') {
        return { approvalId: '', reply: 'always', reason: 'interactive CLI approval (session)' };
    }
    if (answer === 'y' || answer === 'yes' || answer === 'allow' || answer === 'o' || answer === 'once') {
        return { approvalId: '', reply: 'once', reason: 'interactive CLI approval' };
    }
    return { approvalId: '', reply: 'deny', reason: 'interactive CLI approval' };
}

function renderApprovalResult(action: string, reply: PermissionReply['reply'], reason?: string): string {
    if (reply === 'always' && reason?.includes('session')) {
        return `Allowed for session: ${action}\n`;
    }
    switch (reply) {
        case 'always':
            return `Always allow ${action}\n`;
        case 'once':
            return `Approved once ${action}\n`;
        case 'deny':
            return `Denied ${action}\n`;
    }
}

function eventWithPermission(
    options: InteractiveToolOptions,
    request: PermissionRequest,
    decision: PermissionDecision,
) {
    return {
        type: 'permission.requested' as const,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message: `permission requested: ${request.action}`,
        permissionRequest: request,
        permissionDecision: decision,
        modelProviderSelection: options.modelProviderSelection,
    };
}

function eventWithReply(options: InteractiveToolOptions, reply: PermissionReply) {
    return {
        type: 'permission.replied' as const,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message: `permission replied: ${reply.reply}`,
        permissionReply: reply,
        modelProviderSelection: options.modelProviderSelection,
    };
}

function eventWithApproval(
    options: InteractiveToolOptions,
    type: 'approval.requested' | 'approval.updated' | 'approval.blocked' | 'approval.resumed',
    record: ApprovalRecord,
    message: string,
) {
    return {
        type,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message,
        approvalRecord: record,
        modelProviderSelection: options.modelProviderSelection,
    };
}

function isApprovalAnswer(line: string): boolean {
    const answer = line.trim().toLowerCase();
    return ['a', 'always', 'd', 'deny', 'n', 'no', 'o', 'once', 's', 'session', 'y', 'yes', 'allow'].includes(answer);
}

function approvalIdFor(request: PermissionRequest): string {
    return `approval_${request.id}`;
}

function approvalRecordForRequest(request: PermissionRequest, decision: PermissionDecision): ApprovalRecord {
    return {
        approvalId: approvalIdFor(request),
        requestId: request.id,
        policyDecision: decision.status,
        state: 'pending',
        subject: { kind: 'tool', id: request.action },
        requestedAt: new Date().toISOString(),
        reason: decision.reason ?? request.reason,
    };
}

function approvalDecisionRecord(record: ApprovalRecord, reply: PermissionReply): ApprovalRecord {
    return {
        ...record,
        state: reply.reply === 'deny' ? 'denied' : 'approved',
        decidedAt: new Date().toISOString(),
        reason: reply.reason ?? record.reason,
    };
}
