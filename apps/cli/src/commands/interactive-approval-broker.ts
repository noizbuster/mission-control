import {
    createObservabilityRedactor,
    PermissionRuleStore,
    PermissionSession,
    redactAgentEventForObservability,
} from '@mission-control/core';
import type { PermissionDecision, PermissionReply, PermissionRequest } from '@mission-control/protocol';
import { type ApprovalLevel, approvalLevelRules, sanitizeTerminalDisplayText } from '@mission-control/tui/state';
import { permissionRequestFingerprint } from './interactive-approval-fingerprint';
import {
    type ApprovalAttempt,
    approvalRecordForRequest,
    deniedDecision,
    deniedReply,
    eventWithApproval,
    eventWithPermission,
    parsePermissionReply,
    prepareApprovalReply,
    settleApprovalReply,
    type VisibleApprovalAttempt,
} from './interactive-approval-helpers';
import type { InteractiveToolOptions } from './interactive-coding-tools';

export type InteractiveApprovalBroker = {
    readonly requestApproval: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
    readonly primeApproval: (request: PermissionRequest, reason?: string) => void;
    readonly answer: (line: string) => boolean;
    readonly cancel: (reason: string) => void;
    readonly hasPending: () => boolean;
    readonly setApprovalLevel: (level: ApprovalLevel) => void;
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
            write: (text) => options.output.write(sanitizeTerminalDisplayText(redactor.redactText(text))),
            ...(options.output.showApproval !== undefined
                ? {
                      showApproval: (action: string, reason: string) =>
                          options.output.showApproval?.(
                              sanitizeTerminalDisplayText(redactor.redactText(action)),
                              sanitizeTerminalDisplayText(redactor.redactText(reason)),
                          ),
                  }
                : {}),
            ...(options.output.writeTranscriptFallback !== undefined
                ? {
                      writeTranscriptFallback: (text: string) =>
                          options.output.writeTranscriptFallback?.(
                              sanitizeTerminalDisplayText(redactor.redactText(text)),
                          ),
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
    let activeAttempt: ApprovalAttempt | undefined;
    const primedApprovals = new Map<string, string | undefined>();

    const request = (permissionRequest: PermissionRequest): Promise<PermissionDecision> => {
        if (activeAttempt !== undefined) {
            return Promise.resolve({
                requestId: permissionRequest.id,
                status: 'deny',
                reason: 'another approval is already pending',
            });
        }
        const identity = Symbol(permissionRequest.id);
        activeAttempt = { state: 'evaluating', identity, request: permissionRequest };
        return evaluateAttempt(permissionRequest, identity);
    };

    async function evaluateAttempt(
        permissionRequest: PermissionRequest,
        identity: symbol,
    ): Promise<PermissionDecision> {
        const initialAttempt = activeAttempt;
        if (initialAttempt?.identity !== identity) {
            return deniedDecision(permissionRequest, 'approval request is no longer active');
        }
        if (initialAttempt.state === 'cancelled') {
            activeAttempt = undefined;
            return deniedDecision(permissionRequest, initialAttempt.reason);
        }
        const requestFingerprint = permissionRequestFingerprint(permissionRequest);
        if (primedApprovals.has(requestFingerprint)) {
            const reason = primedApprovals.get(requestFingerprint);
            primedApprovals.delete(requestFingerprint);
            activeAttempt = undefined;
            return {
                requestId: permissionRequest.id,
                status: 'allow',
                ...(reason !== undefined ? { reason } : {}),
            };
        }

        const evaluated = await permissionSession.evaluate(permissionRequest, observableOptions.sessionId);
        const evaluatedAttempt = activeAttempt;
        if (evaluatedAttempt?.identity !== identity) {
            return deniedDecision(permissionRequest, 'approval request is no longer active');
        }
        if (evaluatedAttempt.state === 'cancelled') {
            activeAttempt = undefined;
            return deniedDecision(permissionRequest, evaluatedAttempt.reason);
        }
        permissionSession.consumeOnceRules(observableOptions.sessionId, evaluated.consumeOnceRules);
        if (evaluated.decision.status !== 'requires_approval') {
            activeAttempt = undefined;
            return evaluated.decision;
        }

        const approval = approvalRecordForRequest(permissionRequest, evaluated.decision);
        const decision = new Promise<PermissionDecision>((resolve) => {
            activeAttempt = { state: 'visible', identity, request: permissionRequest, record: approval, resolve };
        });
        observableOptions.emitEvent(eventWithPermission(observableOptions, permissionRequest, evaluated.decision));
        observableOptions.emitEvent(
            eventWithApproval(
                observableOptions,
                'approval.requested',
                approval,
                `approval requested: ${permissionRequest.action}`,
            ),
        );
        observableOptions.output.write(`Approve ${permissionRequest.action}? [once/always/deny]:`);
        observableOptions.output.showApproval?.(permissionRequest.action, permissionRequest.reason);
        return decision;
    }

    async function settleAttempt(
        attempt: VisibleApprovalAttempt,
        reply: PermissionReply,
        rememberAuthority = true,
    ): Promise<void> {
        const prepared = prepareApprovalReply(observableOptions, attempt.request, reply);
        const rememberResult =
            rememberAuthority && prepared.remember
                ? await permissionSession
                      .rememberReply(attempt.request, observableOptions.sessionId, prepared.reply, {
                          tryCommitAuthority: () => tryClaimAuthority(attempt.identity),
                      })
                      .then(
                          () => 'remembered' as const,
                          () => 'failed' as const,
                      )
                : 'remembered';
        let current = activeAttempt;
        if (current?.identity !== attempt.identity || current.state !== 'settling') return;
        let finalReply: PermissionReply;
        if (current.commitState === 'open' && current.cancellationReason !== undefined) {
            finalReply = deniedReply(attempt.request, current.cancellationReason);
        } else if (rememberResult === 'failed') {
            finalReply = deniedReply(attempt.request, 'approval settlement failed');
        } else {
            if (current.commitState === 'open' && !tryClaimAuthority(attempt.identity)) {
                current = activeAttempt;
                if (current?.identity !== attempt.identity || current.state !== 'settling') return;
                finalReply = deniedReply(
                    attempt.request,
                    current.cancellationReason ?? 'approval settlement cancelled',
                );
            } else {
                finalReply = prepared.reply;
            }
        }
        activeAttempt = undefined;
        attempt.resolve(settleApprovalReply(observableOptions, attempt.request, attempt.record, finalReply));
    }

    function tryClaimAuthority(identity: symbol): boolean {
        const current = activeAttempt;
        if (
            current?.identity !== identity ||
            current.state !== 'settling' ||
            current.commitState !== 'open' ||
            current.cancellationReason !== undefined
        ) {
            return false;
        }
        activeAttempt = { ...current, commitState: 'claimed' };
        return true;
    }

    function cancelAttempt(reason: string): void {
        primedApprovals.clear();
        const current = activeAttempt;
        if (current === undefined) return;
        if (current.state === 'evaluating') {
            activeAttempt = { state: 'cancelled', identity: current.identity, request: current.request, reason };
            return;
        }
        if (current.state === 'settling') {
            if (current.commitState === 'open' && current.cancellationReason === undefined) {
                activeAttempt = { ...current, cancellationReason: reason };
            }
            return;
        }
        if (current.state !== 'visible') return;
        activeAttempt = {
            state: 'settling',
            identity: current.identity,
            request: current.request,
            commitState: 'open',
            cancellationReason: reason,
        };
        void settleAttempt(current, deniedReply(current.request, reason), false);
    }

    return {
        requestApproval: request,
        requestPermission: request,
        primeApproval: (permissionRequest, reason) => {
            if (activeAttempt !== undefined) return;
            primedApprovals.set(permissionRequestFingerprint(permissionRequest), reason);
        },
        answer: (line) => {
            const current = activeAttempt;
            if (current?.state !== 'visible') return false;
            activeAttempt = {
                state: 'settling',
                identity: current.identity,
                request: current.request,
                commitState: 'open',
            };
            void settleAttempt(current, parsePermissionReply(line));
            return true;
        },
        cancel: cancelAttempt,
        hasPending: () => activeAttempt?.state === 'visible',
        setApprovalLevel: (nextLevel) => {
            permissionSession.replaceBuiltInRules(approvalLevelRules(nextLevel));
        },
    };
}
