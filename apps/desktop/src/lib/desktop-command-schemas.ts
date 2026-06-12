import { type ApprovalRecord, type ModelProviderSelection, RUN_COORDINATOR_STATES } from '@mission-control/protocol';
import { z } from 'zod';

export type DesktopApprovalDecisionState = Extract<
    ApprovalRecord['state'],
    'approved' | 'denied' | 'expired' | 'cancelled'
>;

export type DesktopPromptCommandInput = {
    readonly sessionId: string;
    readonly prompt: string;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly parentMessageId?: string;
    readonly resume?: boolean;
};

export type DesktopRunCommandInput = {
    readonly sessionId: string;
    readonly reason?: string;
};

export type DesktopApprovalDecisionInput = {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly state: DesktopApprovalDecisionState;
    readonly reason?: string;
};

export const DESKTOP_COMMAND_RECEIPT_STATUSES = ['queued', 'blocked', ...RUN_COORDINATOR_STATES] as const;

export const DesktopCommandReceiptSchema = z
    .object({
        sessionId: z.string().min(1),
        status: z.enum(DESKTOP_COMMAND_RECEIPT_STATUSES),
        eventsWritten: z.number().int().nonnegative(),
    })
    .strict();
export type DesktopCommandReceipt = z.infer<typeof DesktopCommandReceiptSchema>;
