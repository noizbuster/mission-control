import type {
    ProtocolErrorCode,
    RunCoordinatorCommand,
    RunCoordinatorEventMetadata,
    RunCoordinatorState,
} from '@mission-control/protocol';
import { redactCredentialText } from '../providers/redaction-handler.js';

export type RunCoordinatorResult = {
    readonly status: 'idle' | 'running' | 'completed' | 'interrupted' | 'failed' | 'blocked_on_approval';
    readonly runId?: string;
    readonly turns: number;
    readonly reason?: string;
    readonly errorCode?: ProtocolErrorCode;
    readonly toolCallId?: string;
};

type RunningActiveRun = {
    readonly kind: 'running';
    readonly runId: string;
    readonly controller: AbortController;
    readonly promise: Promise<RunCoordinatorResult>;
    readonly settled: Promise<RunCoordinatorResult>;
};

type BlockedActiveRun = {
    readonly kind: 'blocked_on_approval';
    readonly runId: string;
    readonly settled: Promise<RunCoordinatorResult>;
    readonly reason?: string;
    readonly errorCode?: ProtocolErrorCode;
    readonly toolCallId?: string;
};

export type RunCoordinatorActiveRun = RunningActiveRun | BlockedActiveRun;

export type RunCoordinatorProviderTurnResult =
    | { readonly status: 'completed' }
    | { readonly status: 'interrupted' }
    | {
          readonly status: 'failed';
          readonly reason: string;
          readonly errorCode: ProtocolErrorCode;
      }
    | {
          readonly status: 'blocked_on_approval';
          readonly reason: string;
          readonly errorCode: ProtocolErrorCode;
          readonly toolCallId?: string;
      };

export type RunCoordinatorRunEventType =
    | 'run.command.received'
    | 'run.started'
    | 'run.completed'
    | 'run.interrupted'
    | 'run.idle'
    | 'run.failed'
    | 'run.blocked';

type AppendRunCoordinatorEvent = (
    type: RunCoordinatorRunEventType,
    command: RunCoordinatorCommand,
    state: RunCoordinatorState,
    message: string,
    run: RunCoordinatorEventMetadata,
) => Promise<void>;

export async function finalizeProviderTurnResult(input: {
    readonly result: RunCoordinatorProviderTurnResult;
    readonly command: RunCoordinatorCommand;
    readonly runId: string;
    readonly turns: number;
    readonly appendRunEvent: AppendRunCoordinatorEvent;
    readonly operatorStop?: { readonly requestId: string; readonly operationId: string };
    readonly suppressInterruptedEvent?: boolean;
}): Promise<RunCoordinatorResult | undefined> {
    const { result, command, runId, turns, appendRunEvent } = input;
    switch (result.status) {
        case 'completed':
            return undefined;
        case 'interrupted':
            if (input.suppressInterruptedEvent !== true) {
                await appendRunEvent('run.interrupted', command, 'interrupted', 'run interrupted', {
                    runId,
                    ...(input.operatorStop !== undefined
                        ? {
                              requestId: input.operatorStop.requestId,
                              operationId: input.operatorStop.operationId,
                              reason: 'operator_aborted' as const,
                          }
                        : {}),
                });
            }
            return { status: 'interrupted', runId, turns };
        case 'failed':
            return finalizeFailedResult(result, command, runId, turns, appendRunEvent);
        case 'blocked_on_approval':
            return finalizeBlockedResult(result, command, runId, turns, appendRunEvent);
        default:
            return assertNeverProviderResult(result);
    }
}

async function finalizeFailedResult(
    result: Extract<RunCoordinatorProviderTurnResult, { readonly status: 'failed' }>,
    command: RunCoordinatorCommand,
    runId: string,
    turns: number,
    appendRunEvent: AppendRunCoordinatorEvent,
): Promise<RunCoordinatorResult> {
    const reason = safeRunReason(result.reason);
    await appendRunEvent('run.failed', command, 'failed', reason, {
        runId,
        reason,
        errorCode: result.errorCode,
    });
    return { status: 'failed', runId, turns, reason, errorCode: result.errorCode };
}

async function finalizeBlockedResult(
    result: Extract<RunCoordinatorProviderTurnResult, { readonly status: 'blocked_on_approval' }>,
    command: RunCoordinatorCommand,
    runId: string,
    turns: number,
    appendRunEvent: AppendRunCoordinatorEvent,
): Promise<RunCoordinatorResult> {
    const reason = safeRunReason(result.reason);
    await appendRunEvent('run.blocked', command, 'blocked_on_approval', reason, {
        runId,
        reason,
        errorCode: result.errorCode,
        ...(result.toolCallId !== undefined ? { toolCallId: result.toolCallId } : {}),
    });
    return {
        status: 'blocked_on_approval',
        runId,
        turns,
        reason,
        errorCode: result.errorCode,
        ...(result.toolCallId !== undefined ? { toolCallId: result.toolCallId } : {}),
    };
}

export function safeRunReason(reason: string): string {
    return redactCredentialText(reason).slice(0, 4096);
}

function assertNeverProviderResult(value: never): never {
    throw new TypeError(`Unexpected provider result: ${JSON.stringify(value)}`);
}
