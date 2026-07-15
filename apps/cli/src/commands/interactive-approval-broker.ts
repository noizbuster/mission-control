import {
    createObservabilityRedactor,
    PermissionRuleStore,
    PermissionSession,
    redactAgentEventForObservability,
} from '@mission-control/core';
import type { ApprovalRecord, PermissionDecision, PermissionReply, PermissionRequest } from '@mission-control/protocol';
import { type ApprovalLevel, approvalLevelRules } from '@mission-control/tui/state';
import {
    approvalDecisionRecord,
    approvalIdFor,
    approvalRecordForRequest,
    eventWithApproval,
    eventWithPermission,
    eventWithReply,
    parsePermissionReply,
    renderApprovalResult,
} from './interactive-approval-helpers.js';
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
    const redactor = options.observabilityRedactor ?? createObservabilityRedactor();
    const observableOptions: InteractiveToolOptions = {
        ...options,
        observabilityRedactor: redactor,
        output: {
            ...options.output,
            write: (text) => options.output.write(redactor.redactText(text)),
            ...(options.output.showApproval !== undefined
                ? {
                      showApproval: (action: string, reason: string) =>
                          options.output.showApproval?.(redactor.redactText(action), redactor.redactText(reason)),
                  }
                : {}),
        },
        emitEvent: (event) => options.emitEvent(redactAgentEventForObservability(event, redactor)),
    };
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
                observableOptions,
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
                observableOptions,
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
            void resolvePendingApproval(observableOptions, permissionSession, current, parsePermissionReply(line));
            return true;
        },
        cancel: (reason) => {
            cancelledReason = reason;
            if (pending === undefined) {
                return;
            }
            const current = pending;
            pending = undefined;
            void resolvePendingApproval(observableOptions, permissionSession, current, {
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
        return resolveQueuedApproval(options, permissionSession, request, approval, parsePermissionReply(queuedAnswer));
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
    const redactor = options.observabilityRedactor ?? createObservabilityRedactor();
    const canRemember = JSON.stringify(redactor.redactValue(request)) === JSON.stringify(request);
    const effectiveReply: PermissionReply = canRemember
        ? normalizedReply
        : {
              approvalId: normalizedReply.approvalId,
              reply: normalizedReply.reply === 'deny' ? 'deny' : 'once',
              reason: 'credential-bearing approval applied once',
          };
    if (canRemember) {
        await permissionSession.rememberReply(request, options.sessionId, effectiveReply);
    }
    options.output.write('\n');
    options.output.hideApproval?.();
    options.output.write(renderApprovalResult(request.action, effectiveReply.reply, effectiveReply.reason));
    options.emitEvent(eventWithReply(options, effectiveReply));
    const decidedRecord = approvalDecisionRecord(record, effectiveReply);
    options.emitEvent(
        eventWithApproval(options, 'approval.updated', decidedRecord, `approval updated: ${decidedRecord.state}`),
    );
    options.emitEvent(
        eventWithApproval(
            options,
            effectiveReply.reply === 'deny' ? 'approval.blocked' : 'approval.resumed',
            decidedRecord,
            effectiveReply.reply === 'deny' ? `approval blocked: ${decidedRecord.state}` : 'approval resumed',
        ),
    );
    return {
        requestId: request.id,
        status: effectiveReply.reply === 'deny' ? 'deny' : 'allow',
        reason: effectiveReply.reason ?? 'interactive CLI approval',
    };
}

function isApprovalAnswer(line: string): boolean {
    const answer = line.trim().toLowerCase();
    return ['a', 'always', 'd', 'deny', 'n', 'no', 'o', 'once', 's', 'session', 'y', 'yes', 'allow'].includes(answer);
}
