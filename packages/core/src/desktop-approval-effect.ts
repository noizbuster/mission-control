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

export const DESKTOP_APPROVAL_EFFECT_OUTCOMES = ['completed', 'failed'] as const;
export type DesktopApprovalEffectOutcome = (typeof DESKTOP_APPROVAL_EFFECT_OUTCOMES)[number];

type DesktopApprovalEffectRecordBase = {
    readonly effect: DesktopApprovalEffect;
    readonly requestedAt: string;
};

export type DesktopApprovalEffectPendingRecord = DesktopApprovalEffectRecordBase & {
    readonly state: 'pending';
};

export type DesktopApprovalEffectExecutingRecord = DesktopApprovalEffectRecordBase & {
    readonly state: 'executing';
    readonly executionToken: string;
    readonly leaseExpiresAt: string;
    readonly executingAt: string;
};

export type DesktopApprovalEffectSettledRecord = DesktopApprovalEffectRecordBase & {
    readonly state: 'settled';
    readonly executionToken: string;
    readonly leaseExpiresAt: string;
    readonly executingAt: string;
    readonly outcome: DesktopApprovalEffectOutcome;
    readonly settledAt: string;
};

export type DesktopApprovalEffectUnknownRecord = DesktopApprovalEffectRecordBase & {
    readonly state: 'unknown';
    readonly executionToken: string;
    readonly leaseExpiresAt: string;
    readonly executingAt: string;
    readonly unknownAt: string;
} & (
        | { readonly outcome?: undefined; readonly resolvedAt?: undefined }
        | { readonly outcome: DesktopApprovalEffectOutcome; readonly resolvedAt: string }
    );

export type DesktopApprovalEffectRecord =
    | DesktopApprovalEffectPendingRecord
    | DesktopApprovalEffectExecutingRecord
    | DesktopApprovalEffectSettledRecord
    | DesktopApprovalEffectUnknownRecord;

export type DesktopApprovalEffectClaimInput = {
    readonly effect: DesktopApprovalEffect;
    readonly executionToken: string;
    readonly leaseExpiresAt: string;
};

export type DesktopApprovalEffectClaimResult =
    | { readonly status: 'claimed'; readonly record: DesktopApprovalEffectExecutingRecord }
    | { readonly status: 'missing' | 'identity_mismatch' }
    | {
          readonly status: 'executing';
          readonly record: DesktopApprovalEffectExecutingRecord;
      }
    | { readonly status: 'settled'; readonly record: DesktopApprovalEffectSettledRecord }
    | { readonly status: 'unknown'; readonly record: DesktopApprovalEffectUnknownRecord };

export type DesktopApprovalEffectSettlementInput = {
    readonly effect: DesktopApprovalEffect;
    readonly executionToken: string;
    readonly outcome: DesktopApprovalEffectOutcome;
};

export type DesktopApprovalEffectResolutionInput = {
    readonly approvalId: string;
    readonly outcome: DesktopApprovalEffectOutcome;
    readonly resolvedAt: string;
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
