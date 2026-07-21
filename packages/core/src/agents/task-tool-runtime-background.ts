import type { SessionControlEpoch } from '../runtime/session-control-cancellation';
import type { ChildSpawnRequest, ChildSpawnResult, TaskToolBackgroundHandle } from '../tools/task/task-tool';
import type { JobExecuteFn } from './async-job-manager';
import { childDisplayName } from './task-tool-runtime-authority';
import type { TaskToolRuntimeServices } from './task-tool-runtime-contract';
import {
    attachChildControl,
    type ChildControlPrimaryFailure,
    ChildSessionCancelledError,
    disposeChildControl,
    rethrowAfterChildCleanup,
    settleChildCompletion,
} from './task-tool-runtime-control';

export function startBackgroundChildSession(input: {
    readonly request: ChildSpawnRequest;
    readonly services: TaskToolRuntimeServices;
    readonly parentSessionId: string;
    readonly authorityFingerprint: string;
    readonly executeSpawn: (
        sessionId: string,
        signal: AbortSignal,
        controlEpoch?: SessionControlEpoch,
    ) => Promise<ChildSpawnResult>;
}): TaskToolBackgroundHandle {
    const { jobManager, runtimeRegistry } = input.services;
    const sessionId = input.request.sessionId;
    const agentId = childDisplayName(input.request);
    runtimeRegistry.adopt({
        id: sessionId,
        displayName: agentId,
        kind: 'sub',
        parentId: input.parentSessionId,
        authorityFingerprint: input.authorityFingerprint,
        taskDepth: input.request.taskDepth ?? 0,
        status: 'running',
        sessionId,
    });

    const execute: JobExecuteFn = async (signal, controlEpoch) => {
        const controlled = await attachChildControl(input.services, sessionId, signal).catch((error: unknown) =>
            rethrowAfterChildCleanup(error, () =>
                settleChildCompletion({
                    services: input.services,
                    runtimeRegistry,
                    parentSessionId: input.parentSessionId,
                    sessionId,
                    result: failedChildResult(sessionId, error),
                    ...(controlEpoch !== undefined ? { controlEpoch } : {}),
                    resolveWait: false,
                }),
            ),
        );
        let primaryFailure: ChildControlPrimaryFailure | undefined;
        try {
            if (controlled.signal.aborted) {
                const cancellationError = new ChildSessionCancelledError(sessionId);
                await rethrowAfterChildCleanup(cancellationError, () =>
                    settleChildCompletion({
                        services: input.services,
                        runtimeRegistry,
                        parentSessionId: input.parentSessionId,
                        sessionId,
                        result: failedChildResult(sessionId, cancellationError),
                        ...(controlEpoch !== undefined ? { controlEpoch } : {}),
                        resolveWait: false,
                    }),
                );
            }
            const result = await input
                .executeSpawn(sessionId, controlled.signal, controlEpoch)
                .catch((error: unknown) =>
                    rethrowAfterChildCleanup(error, () =>
                        settleChildCompletion({
                            services: input.services,
                            runtimeRegistry,
                            parentSessionId: input.parentSessionId,
                            sessionId,
                            result: failedChildResult(sessionId, error),
                            ...(controlEpoch !== undefined ? { controlEpoch } : {}),
                            resolveWait: false,
                        }),
                    ),
                );
            await settleChildCompletion({
                services: input.services,
                runtimeRegistry,
                parentSessionId: input.parentSessionId,
                sessionId,
                result,
                ...(controlEpoch !== undefined ? { controlEpoch } : {}),
                resolveWait: false,
            });
            return { status: result.status, output: result.output };
        } catch (error: unknown) {
            primaryFailure = { error };
            throw error;
        } finally {
            await disposeChildControl(controlled, primaryFailure);
        }
    };

    const handle = jobManager.startJob({
        sessionId,
        parentSessionId: input.parentSessionId,
        agentId,
        blocking: false,
        execute,
        onTerminatedBeforeStart: () => runtimeRegistry.update(sessionId, { status: 'aborted' }),
        ...(input.request.signal !== undefined ? { signal: input.request.signal } : {}),
        ...(input.request.controlEpoch !== undefined ? { controlEpoch: input.request.controlEpoch } : {}),
    });
    return { sessionId, backgroundId: handle.jobId };
}

function failedChildResult(sessionId: string, error: unknown): ChildSpawnResult {
    return {
        sessionId,
        status: 'failed',
        output: error instanceof Error ? error.message : String(error),
    };
}
