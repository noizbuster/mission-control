import type {
    ProtocolErrorCode,
    RunCoordinatorCommand,
    RunCoordinatorEventMetadata,
    RunCoordinatorState,
} from '@mission-control/protocol';

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
}): Promise<RunCoordinatorResult | undefined> {
    const { result, command, runId, turns, appendRunEvent } = input;
    switch (result.status) {
        case 'completed':
            return undefined;
        case 'interrupted':
            await appendRunEvent('run.interrupted', command, 'interrupted', 'run interrupted', { runId });
            return { status: 'interrupted', runId, turns };
        case 'failed':
            await appendRunEvent('run.failed', command, 'failed', result.reason, {
                runId,
                reason: result.reason,
                errorCode: result.errorCode,
            });
            return { status: 'failed', runId, turns, reason: result.reason, errorCode: result.errorCode };
        case 'blocked_on_approval':
            await appendRunEvent('run.blocked', command, 'blocked_on_approval', result.reason, {
                runId,
                reason: result.reason,
                errorCode: result.errorCode,
                ...(result.toolCallId !== undefined ? { toolCallId: result.toolCallId } : {}),
            });
            return {
                status: 'blocked_on_approval',
                runId,
                turns,
                reason: result.reason,
                errorCode: result.errorCode,
                ...(result.toolCallId !== undefined ? { toolCallId: result.toolCallId } : {}),
            };
        default:
            return assertNeverProviderResult(result);
    }
}

function assertNeverProviderResult(value: never): never {
    throw new TypeError(`Unexpected provider result: ${JSON.stringify(value)}`);
}
