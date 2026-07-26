import {
    type SessionAwaitingDetails,
    SessionAwaitingDetailsSchema,
    type SessionStatus,
} from '@mission-control/protocol';
import { assertUnreachable } from '../assert-unreachable';

export type SessionStatusDisplayInput = {
    readonly status: SessionStatus | 'corrupt' | 'missing';
    readonly awaiting?: SessionAwaitingDetails | undefined;
};

export function formatSessionStatusLabel(input: SessionStatusDisplayInput): string {
    switch (input.status) {
        case 'awaiting': {
            const awaiting = parseAwaitingDetails(input.awaiting);
            return awaiting === undefined ? 'awaiting' : formatAwaitingReason(awaiting.reason);
        }
        case 'idle':
        case 'running':
        case 'stopped':
        case 'failed':
        case 'corrupt':
        case 'missing':
            return input.status;
        default:
            return assertUnreachable(input.status, 'session status variant');
    }
}

export function formatSessionStatusWithSource(input: SessionStatusDisplayInput): string {
    const label = formatSessionStatusLabel(input);
    const awaiting = parseAwaitingDetails(input.awaiting);
    if (input.status !== 'awaiting' || awaiting === undefined) {
        return label;
    }
    const source = formatAwaitingSource(awaiting);
    return source.length === 0 ? label : `${label} (${source})`;
}

function parseAwaitingDetails(value: SessionStatusDisplayInput['awaiting']): SessionAwaitingDetails | undefined {
    const parsed = SessionAwaitingDetailsSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

export function formatAwaitingSource(awaiting: SessionAwaitingDetails): string {
    const segments: string[] = [];
    if (awaiting.source.approvalId !== undefined) {
        segments.push(`approval=${awaiting.source.approvalId}`);
    }
    if (awaiting.source.inputId !== undefined) {
        segments.push(`input=${awaiting.source.inputId}`);
    }
    if (awaiting.source.runId !== undefined) {
        segments.push(`run=${awaiting.source.runId}`);
    }
    if (awaiting.source.toolCallId !== undefined) {
        segments.push(`tool=${awaiting.source.toolCallId}`);
    }
    if (awaiting.source.jobId !== undefined) {
        segments.push(`job=${awaiting.source.jobId}`);
    }
    if (awaiting.source.childSessionId !== undefined) {
        segments.push(`child=${awaiting.source.childSessionId}`);
    }
    return segments.join(',');
}

function formatAwaitingReason(reason: SessionAwaitingDetails['reason']): string {
    switch (reason) {
        case 'approval':
            return 'awaiting approval';
        case 'user_input':
            return 'awaiting user input';
        case 'subagent':
            return 'awaiting subagent';
        default:
            return assertUnreachable(reason, 'session status variant');
    }
}
