import type { ChildSpawnRequest, ChildSpawnResult } from '../tools/task/task-tool';
import { MissingChildSpawnConfigurationError } from './child-graph-spawn';
import type { RuntimeAgentRegistry } from './runtime-registry';
import type { TaskToolRuntimeServices } from './task-tool-runtime-contract';
import {
    attachChildControl,
    type ChildControlPrimaryFailure,
    ChildSessionCancelledError,
    ChildSessionCleanupError,
    disposeChildControl,
    rethrowAfterChildCleanup,
    settleChildCompletion,
    unreportedChildFailure,
} from './task-tool-runtime-control';

type ForegroundChildIdentity = {
    readonly sessionId: string;
    readonly agentId: string;
    readonly authorityFingerprint: string;
    readonly taskDepth: number;
};

export async function runForegroundChildSession(input: {
    readonly child: ForegroundChildIdentity;
    readonly parentSessionId: string;
    readonly request: ChildSpawnRequest;
    readonly services: TaskToolRuntimeServices | undefined;
    readonly runtimeRegistry: RuntimeAgentRegistry;
    readonly spawn: (signal: AbortSignal) => Promise<ChildSpawnResult>;
}): Promise<ChildSpawnResult> {
    const { child, parentSessionId, request, services, runtimeRegistry } = input;
    const controlled = await attachChildControl(services, child.sessionId, request.signal);
    const settle = (result: ChildSpawnResult, resolveWait: boolean): Promise<void> =>
        settleChildCompletion({
            services,
            runtimeRegistry,
            parentSessionId,
            sessionId: child.sessionId,
            result,
            ...(request.controlEpoch !== undefined ? { controlEpoch: request.controlEpoch } : {}),
            resolveWait,
        });
    let primaryFailure: ChildControlPrimaryFailure | undefined;
    let terminalResultReported = false;
    try {
        if (controlled.signal.aborted) throw new ChildSessionCancelledError(child.sessionId);
        runtimeRegistry.adopt({
            id: child.sessionId,
            displayName: child.agentId,
            kind: 'sub',
            parentId: parentSessionId,
            authorityFingerprint: child.authorityFingerprint,
            taskDepth: child.taskDepth,
            status: 'running',
            sessionId: child.sessionId,
            ...(request.category !== undefined ? { category: request.category.id } : {}),
            ...(request.title !== undefined ? { title: request.title } : {}),
        });
        if (services?.mirror !== undefined) {
            await services.mirror
                .startSubagentWait({
                    parentSessionId,
                    childSessionId: child.sessionId,
                    agentId: child.agentId,
                    mode: 'sync',
                })
                .catch((error: unknown) =>
                    rethrowAfterChildCleanup(error, () => settle(failedChildResult(child.sessionId, error), false)),
                );
        }
        if (controlled.signal.aborted) {
            const cancellationError = new ChildSessionCancelledError(child.sessionId);
            await rethrowAfterChildCleanup(cancellationError, () =>
                settle(failedChildResult(child.sessionId, cancellationError), true),
            );
        }
        let result: ChildSpawnResult;
        let spawnFailure: unknown;
        try {
            result = await input.spawn(controlled.signal);
        } catch (error: unknown) {
            if (error instanceof MissingChildSpawnConfigurationError) throw error;
            spawnFailure = error;
            result = unreportedChildFailure(child.sessionId);
        }
        try {
            await settle(result, true);
        } catch (settlementError: unknown) {
            if (spawnFailure !== undefined) {
                throw new ChildSessionCleanupError(spawnFailure, settlementError);
            }
            throw settlementError;
        }
        terminalResultReported = true;
        return result;
    } catch (error: unknown) {
        primaryFailure = { error };
        throw error;
    } finally {
        if (terminalResultReported) {
            try {
                await controlled.dispose();
            } catch {
                // Lifecycle cleanup cannot replace a settled child terminal result.
            }
        } else {
            await disposeChildControl(controlled, primaryFailure);
        }
    }
}

function failedChildResult(sessionId: string, error: unknown): ChildSpawnResult {
    if (error instanceof ChildSessionCancelledError) {
        return {
            sessionId,
            status: 'failed',
            output: '',
            failureKind: 'aborted',
        };
    }
    return unreportedChildFailure(sessionId);
}
