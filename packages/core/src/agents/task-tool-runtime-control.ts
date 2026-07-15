import type { SessionControlEpoch } from '../runtime/session-control-cancellation';
import type { SessionControlHost } from '../runtime/session-control-host';
import type { ChildSpawnResult } from '../tools/task/task-tool';
import { ToolExecutionError } from '../tools/tool-registry-types';
import { LifecycleCleanupError } from './lifecycle-cleanup-error';
import type { RuntimeAgentRegistry } from './runtime-registry';
import type { TaskToolRuntimeServices } from './task-tool-runtime-contract';

export type ChildControl = {
    readonly signal: AbortSignal;
    readonly dispose: () => Promise<void>;
};

export type ChildControlPrimaryFailure = { readonly error: unknown };

export class ChildSessionCleanupError extends LifecycleCleanupError {
    constructor(primaryError: unknown, suppressedError: unknown) {
        super({
            name: 'ChildSessionCleanupError',
            message: 'child session failed and cleanup also failed',
            primaryError,
            suppressedError,
        });
    }
}

export class QuarantinedChildSettlementError extends Error {
    readonly sessionId: string;

    constructor(sessionId: string) {
        super(`child settlement quarantined: ${sessionId}`);
        this.name = 'QuarantinedChildSettlementError';
        this.sessionId = sessionId;
    }
}

export class ChildSessionCancelledError extends Error {
    readonly sessionId: string;

    constructor(sessionId: string) {
        super(`child session cancelled before start: ${sessionId}`);
        this.name = 'ChildSessionCancelledError';
        this.sessionId = sessionId;
    }
}

export async function attachChildControl(
    services: TaskToolRuntimeServices | undefined,
    sessionId: string,
    upstreamSignal: AbortSignal | undefined,
): Promise<ChildControl> {
    const host: SessionControlHost | undefined = services?.sessionControlHost;
    if (host === undefined) {
        return { signal: upstreamSignal ?? new AbortController().signal, dispose: async () => undefined };
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    let listening = false;
    if (upstreamSignal?.aborted === true) controller.abort();
    else if (upstreamSignal !== undefined) {
        upstreamSignal.addEventListener('abort', abort, { once: true });
        listening = true;
    }
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
    });
    let attachment: Awaited<ReturnType<SessionControlHost['attachEntity']>>;
    try {
        attachment = await host.attachEntity({
            sessionId,
            kind: 'child',
            entityId: sessionId,
            handles: [{ kind: 'subagent', handleId: `subagent:${sessionId}`, abort, settled }],
        });
    } catch (error: unknown) {
        if (listening && upstreamSignal !== undefined) upstreamSignal.removeEventListener('abort', abort);
        throw error;
    }
    let disposal: Promise<void> | undefined;
    return {
        signal: controller.signal,
        dispose: () => {
            if (disposal !== undefined) return disposal;
            if (listening && upstreamSignal !== undefined) {
                listening = false;
                upstreamSignal.removeEventListener('abort', abort);
            }
            resolveSettled();
            disposal = Promise.resolve().then(() => attachment.detach());
            return disposal;
        },
    };
}

export async function rethrowAfterChildCleanup(primaryError: unknown, cleanup: () => Promise<void>): Promise<never> {
    try {
        await cleanup();
    } catch (cleanupError: unknown) {
        throw new ChildSessionCleanupError(primaryError, cleanupError);
    }
    throw primaryError;
}

export async function disposeChildControl(
    control: ChildControl,
    primaryFailure?: ChildControlPrimaryFailure,
): Promise<void> {
    try {
        await control.dispose();
    } catch (cleanupError: unknown) {
        if (primaryFailure === undefined) throw cleanupError;
        throw new ChildSessionCleanupError(primaryFailure.error, cleanupError);
    }
}

export async function settleChildCompletion(input: {
    readonly services: TaskToolRuntimeServices | undefined;
    readonly runtimeRegistry: RuntimeAgentRegistry;
    readonly parentSessionId: string;
    readonly sessionId: string;
    readonly result: ChildSpawnResult;
    readonly controlEpoch?: SessionControlEpoch;
    readonly resolveWait: boolean;
}): Promise<void> {
    const status = input.result.status === 'failed' ? 'aborted' : 'idle';
    const mirrorInput = {
        parentSessionId: input.parentSessionId,
        childSessionId: input.sessionId,
        status: input.result.status,
        output: input.result.output,
    } as const;
    const fence = input.controlEpoch?.callbackFence;
    if (fence === undefined) {
        if (input.resolveWait) await input.services?.mirror?.resolveSubagentWait(mirrorInput);
        input.runtimeRegistry.update(input.sessionId, { status });
        return;
    }
    const mirror = input.services?.mirror;
    if (mirror === undefined) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: 'controlled subagent settlement requires a durable mirror',
            retryable: false,
        });
    }
    const settlement = await fence.settle({
        handleKind: 'subagent',
        handleId: `subagent:${input.sessionId}`,
        attemptedEventType: input.result.status === 'failed' ? 'subagent.failed' : 'subagent.completed',
        metadata: { status: input.result.status },
        ...(input.resolveWait && mirror !== undefined
            ? { write: (client) => mirror.resolveSubagentWait(mirrorInput, client) }
            : {}),
    });
    if (!settlement.accepted) throw new QuarantinedChildSettlementError(input.sessionId);
    input.runtimeRegistry.update(input.sessionId, { status });
}
