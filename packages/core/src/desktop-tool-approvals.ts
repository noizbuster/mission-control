import { defaultModelProviderSelection } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ApprovalTerminalState } from './approval-gate';
import {
    type DesktopApprovalEffect,
    type DesktopApprovalEffectClaimInput,
    type DesktopApprovalEffectClaimResult,
    type DesktopApprovalEffectRecord,
    type DesktopApprovalEffectResolutionInput,
    type DesktopApprovalEffectSettlementInput,
    desktopApprovalEffect,
} from './desktop-approval-effect';
import { withDesktopApprovalSettlementLock } from './desktop-approval-settlement-lock';
import type { DesktopApprovalBackfillStore } from './desktop-tool-approval-backfill';
import {
    approvalEvent,
    decidedRecord,
    hasTerminalRunAfterApproval,
    pendingApprovalContextForCurrentRun,
} from './desktop-tool-approval-events';
import { executeApprovedDesktopTool } from './desktop-tool-approval-execution';
import type { CommandExecutionRequest, CommandExecutionResult } from './tools/command-run';
import { randomUUID } from 'node:crypto';

export {
    ensurePendingToolApprovalForCurrentBlockedRun,
    ensureRuntimeOwnedPermissionRequestForBlockedToolCall,
} from './desktop-tool-approval-backfill';

const DEFAULT_DESKTOP_APPROVAL_EFFECT_LEASE_MS = 300_000;

export type DesktopApprovalStore = DesktopApprovalBackfillStore & {
    readonly claimDesktopApprovalEffect: (
        input: DesktopApprovalEffectClaimInput,
    ) => Promise<DesktopApprovalEffectClaimResult>;
    readonly settleDesktopApprovalEffect: (input: DesktopApprovalEffectSettlementInput) => Promise<boolean>;
    readonly getDesktopApprovalEffect: (approvalId: string) => Promise<DesktopApprovalEffectRecord | undefined>;
    readonly resolveDesktopApprovalEffect: (
        input: DesktopApprovalEffectResolutionInput,
    ) => Promise<DesktopApprovalEffectRecord | undefined>;
};

export type DesktopApprovalDecisionInput = {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly state: ApprovalTerminalState;
    readonly reason?: string;
};

export type DesktopApprovalSettlementOptions = {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly now: () => string;
    readonly createExecutionToken?: () => string;
    readonly executionLeaseMs?: number;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

export type DesktopApprovalSettlementStatus = 'completed' | 'blocked' | 'failed' | 'idle' | 'unknown';

export async function settleDesktopApproval(
    input: DesktopApprovalDecisionInput,
    options: DesktopApprovalSettlementOptions,
): Promise<DesktopApprovalSettlementStatus> {
    return withDesktopApprovalSettlementLock(options.store, input, () => settleDesktopApprovalUnlocked(input, options));
}

async function settleDesktopApprovalUnlocked(
    input: DesktopApprovalDecisionInput,
    options: DesktopApprovalSettlementOptions,
): Promise<DesktopApprovalSettlementStatus> {
    const events = await options.store.getEvents(input.sessionId);
    const pendingApproval = pendingApprovalContextForCurrentRun(events, input.approvalId);
    if (pendingApproval === undefined) {
        return (await options.store.getDesktopApprovalEffect(input.approvalId))?.state === 'unknown'
            ? 'unknown'
            : 'idle';
    }
    const pending = pendingApproval.record;
    if (hasTerminalRunAfterApproval(events, pending.approvalId, pendingApproval.runId)) {
        return 'idle';
    }
    const toolCall = await options.store.getDesktopApprovalToolCall(pendingApproval.toolCall.toolCallId);
    if (toolCall === undefined || toolCall.toolName !== pendingApproval.toolCall.toolName) return 'idle';
    const effect = desktopApprovalEffect({
        sessionId: input.sessionId,
        approvalId: pending.approvalId,
        runId: pendingApproval.runId,
        toolCall,
        workspaceRoot: options.workspaceRoot,
    });
    await options.store.reserveDesktopApprovalEffect(effect);
    const executionToken = options.createExecutionToken?.() ?? randomUUID();
    const executingAt = options.now();
    const claim = await options.store.claimDesktopApprovalEffect({
        effect,
        executionToken,
        leaseExpiresAt: new Date(
            Date.parse(executingAt) + (options.executionLeaseMs ?? DEFAULT_DESKTOP_APPROVAL_EFFECT_LEASE_MS),
        ).toISOString(),
    });
    if (claim.status !== 'claimed') return statusForUnclaimedEffect(claim);
    const modelProviderSelection = options.modelProviderSelection ?? defaultModelProviderSelection;
    const decided = decidedRecord(pending, input.state, options.now(), input.reason);
    await options.store.append(
        approvalEvent({
            type: 'approval.updated',
            sessionId: input.sessionId,
            modelProviderSelection,
            record: decided,
            message: `approval updated: ${input.state}`,
            now: options.now,
        }),
    );
    if (input.state !== 'approved') {
        await options.store.append(
            approvalEvent({
                type: 'approval.blocked',
                sessionId: input.sessionId,
                modelProviderSelection,
                record: decided,
                message: `approval blocked: ${input.state}`,
                now: options.now,
            }),
        );
        return (await settleClaimedEffect(options, effect, executionToken, 'failed')) ? 'blocked' : 'unknown';
    }
    await options.store.append(
        approvalEvent({
            type: 'approval.resumed',
            sessionId: input.sessionId,
            modelProviderSelection,
            record: decided,
            message: 'approval resumed',
            now: options.now,
        }),
    );
    const outcome = await executeApprovedDesktopTool({
        append: (event) => options.store.append(event),
        sessionId: options.sessionId,
        workspaceRoot: options.workspaceRoot,
        toolCall,
        record: decided,
        modelProviderSelection,
        ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
    });
    return (await settleClaimedEffect(options, effect, executionToken, outcome)) ? outcome : 'unknown';
}

async function settleClaimedEffect(
    options: DesktopApprovalSettlementOptions,
    effect: DesktopApprovalEffect,
    executionToken: string,
    outcome: 'completed' | 'failed',
): Promise<boolean> {
    return options.store.settleDesktopApprovalEffect({
        effect,
        executionToken,
        outcome,
    });
}

function statusForUnclaimedEffect(claim: Exclude<DesktopApprovalEffectClaimResult, { readonly status: 'claimed' }>) {
    switch (claim.status) {
        case 'unknown':
            return 'unknown' as const;
        case 'executing':
        case 'settled':
        case 'missing':
        case 'identity_mismatch':
            return 'idle' as const;
        default:
            return assertNeverUnclaimedEffect(claim);
    }
}

function assertNeverUnclaimedEffect(claim: never): never {
    throw new TypeError(`Unexpected desktop approval effect claim: ${JSON.stringify(claim)}`);
}
