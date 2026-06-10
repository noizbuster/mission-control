import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import type { InteractiveToolOptions } from './interactive-coding-tools.js';

export type InteractiveApprovalBroker = {
    readonly requestApproval: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly answer: (line: string) => boolean;
    readonly cancel: (reason: string) => void;
    readonly hasPending: () => boolean;
};

export function createInteractiveApprovalBroker(options: InteractiveToolOptions): InteractiveApprovalBroker {
    let pending: PendingApproval | undefined;
    let cancelledReason: string | undefined;
    const queuedAnswers: string[] = [];
    const cachedDecisions = new Map<string, PermissionDecision>();

    return {
        requestApproval: (request) =>
            requestApproval(
                options,
                request,
                (next) => {
                    pending = next;
                },
                queuedAnswers,
                cachedDecisions,
            ),
        requestPermission: (request) => {
            const cached = cachedDecisions.get(request.action);
            if (cached !== undefined) {
                cachedDecisions.delete(request.action);
                return Promise.resolve({ ...cached, requestId: request.id });
            }
            if (cancelledReason !== undefined) {
                return Promise.resolve({ requestId: request.id, status: 'deny', reason: cancelledReason });
            }
            if (pending !== undefined) {
                return Promise.resolve({
                    requestId: request.id,
                    status: 'deny',
                    reason: 'another approval is already pending',
                });
            }
            options.emitEvent(eventWithPermission(options, request));
            options.output.write(`Approve ${request.action}? [y/N]:`);
            return new Promise((resolve) => {
                pending = { request, resolve };
            });
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
            const decision = decisionForLine(current.request, line);
            options.output.write('\n');
            options.output.write(
                decision.status === 'allow'
                    ? `Approved ${current.request.action}\n`
                    : `Denied ${current.request.action}\n`,
            );
            options.emitEvent(eventWithDecision(options, decision));
            if (current.cacheAction !== undefined) {
                cachedDecisions.set(current.cacheAction, decision);
            }
            current.resolve(decision);
            return true;
        },
        cancel: (reason) => {
            cancelledReason = reason;
            if (pending === undefined) {
                return;
            }
            const current = pending;
            pending = undefined;
            const decision: PermissionDecision = { requestId: current.request.id, status: 'deny', reason };
            options.output.write(`\nDenied ${current.request.action}\n`);
            options.emitEvent(eventWithDecision(options, decision));
            current.resolve(decision);
        },
        hasPending: () => pending !== undefined,
    };
}

type PendingApproval = {
    readonly request: PermissionRequest;
    readonly resolve: (decision: PermissionDecision) => void;
    readonly cacheAction?: string;
};

function requestApproval(
    options: InteractiveToolOptions,
    request: PermissionRequest,
    setPending: (approval: PendingApproval) => void,
    queuedAnswers: string[],
    cachedDecisions: Map<string, PermissionDecision>,
): Promise<PermissionDecision> {
    options.emitEvent(eventWithPermission(options, request));
    options.output.write(`Approve ${request.action}? [y/N]:`);
    const queuedAnswer = queuedAnswers.shift();
    if (queuedAnswer !== undefined) {
        const decision = decisionForLine(request, queuedAnswer);
        options.output.write('\n');
        options.output.write(
            decision.status === 'allow' ? `Approved ${request.action}\n` : `Denied ${request.action}\n`,
        );
        options.emitEvent(eventWithDecision(options, decision));
        cachedDecisions.set(request.action, decision);
        return Promise.resolve(decision);
    }
    return new Promise((resolve) => {
        setPending({ request, resolve, cacheAction: request.action });
    });
}

function decisionForLine(request: PermissionRequest, line: string): PermissionDecision {
    const answer = line.trim().toLowerCase();
    return {
        requestId: request.id,
        status: answer === 'y' || answer === 'yes' || answer === 'allow' ? 'allow' : 'deny',
        reason: 'interactive CLI approval',
    };
}

function eventWithPermission(options: InteractiveToolOptions, request: PermissionRequest) {
    return {
        type: 'approval.requested' as const,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message: `approval requested: ${request.action}`,
        permissionRequest: request,
        modelProviderSelection: options.modelProviderSelection,
    };
}

function eventWithDecision(options: InteractiveToolOptions, decision: PermissionDecision) {
    return {
        type: 'approval.updated' as const,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message: `approval ${decision.status}: ${decision.requestId}`,
        permissionDecision: decision,
        modelProviderSelection: options.modelProviderSelection,
    };
}

function isApprovalAnswer(line: string): boolean {
    const answer = line.trim().toLowerCase();
    return (
        answer === 'y' ||
        answer === 'yes' ||
        answer === 'n' ||
        answer === 'no' ||
        answer === 'allow' ||
        answer === 'deny'
    );
}
