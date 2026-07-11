import type {
    SessionOwnerControlRequest,
    SessionOwnerControlToken,
    SessionStopBarrierKind,
} from '@mission-control/protocol';
import type { SessionChildSpawnBarrier } from './session-child-spawn-barrier.js';
import { SessionOwnerControlServerError } from './session-owner-control-token.js';
import type { ExactSessionStopAcquisition } from './session-stop-service.js';

export type SessionOwnerControlTokenState = {
    readonly token: SessionOwnerControlToken;
    readonly requestId: string;
    readonly barrierKind: SessionStopBarrierKind;
    readonly acquisition: ExactSessionStopAcquisition | undefined;
    readonly childSpawnBarrier: SessionChildSpawnBarrier | undefined;
    pendingStopResponses: number;
    readonly stopResponseWaiters: Array<() => void>;
};

export function assertSessionOwnerControlAcquireMatches(
    state: SessionOwnerControlTokenState,
    params: Extract<SessionOwnerControlRequest, { method: 'session.acquire' }>['params'],
): void {
    if (
        state.requestId !== params.requestId ||
        state.token.timeoutMs !== params.timeoutMs ||
        state.barrierKind !== (params.barrierKind ?? 'all_mutations')
    ) {
        throw new SessionOwnerControlServerError('token_invalid');
    }
}

export function waitForSessionOwnerControlStopResponses(state: SessionOwnerControlTokenState): Promise<void> {
    if (state.pendingStopResponses === 0) return Promise.resolve();
    return new Promise((resolve) => state.stopResponseWaiters.push(resolve));
}

export function finishSessionOwnerControlStopResponse(state: SessionOwnerControlTokenState): void {
    state.pendingStopResponses = Math.max(0, state.pendingStopResponses - 1);
    if (state.pendingStopResponses !== 0) return;
    for (const resolve of state.stopResponseWaiters.splice(0)) resolve();
}
