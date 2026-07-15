import {
    SESSION_OWNER_CONTROL_PROTOCOL_VERSION,
    type SessionOwnerControlRequest,
    SessionOwnerControlRequestSchema,
    type SessionOwnerControlToken,
} from '@mission-control/protocol';
import { SessionControlFencedError, type SessionControlHost } from './session-control-host';
import { preserveAuthenticatedSessionControlSocketDuringClose } from './session-control-registry-auth';
import {
    attachSessionOwnerControlFrameReader,
    encodeSessionOwnerControlFrame,
    parseSessionOwnerControlFrame,
} from './session-owner-control-framing';
import {
    sessionOwnerControlErrorResponse,
    sessionOwnerControlRequestId,
    trackSessionOwnerControlStopResponse,
} from './session-owner-control-response';
import {
    createSessionOwnerControlToken,
    matchesSessionOwnerControlToken,
    SessionOwnerControlServerError,
} from './session-owner-control-token';
import {
    assertSessionOwnerControlAcquireMatches,
    finishSessionOwnerControlStopResponse,
    type SessionOwnerControlTokenState,
    waitForSessionOwnerControlStopResponses,
} from './session-owner-control-token-state';
import { SessionStopService } from './session-stop-service';
import type { Duplex } from 'node:stream';

export class SessionOwnerControlServer {
    private readonly sessionId: string;
    private readonly host: SessionControlHost;
    private readonly service: SessionStopService;
    private readonly byOperation = new Map<string, SessionOwnerControlTokenState>();
    private readonly byValue = new Map<string, SessionOwnerControlTokenState>();
    private readonly pendingByOperation = new Map<string, Promise<SessionOwnerControlTokenState>>();

    constructor(input: {
        readonly sessionId: string;
        readonly host: SessionControlHost;
        readonly service: SessionStopService;
    }) {
        this.sessionId = input.sessionId;
        this.host = input.host;
        this.service = input.service;
    }

    accept(socket: Duplex, initialBytes: Buffer): void {
        socket.on('error', () => socket.destroy());
        attachSessionOwnerControlFrameReader({
            socket,
            initialBytes,
            onFrame: async (value) => {
                let request: SessionOwnerControlRequest;
                try {
                    request = parseSessionOwnerControlFrame(SessionOwnerControlRequestSchema, value);
                } catch {
                    socket.write(
                        encodeSessionOwnerControlFrame(
                            sessionOwnerControlErrorResponse(sessionOwnerControlRequestId(value), 'invalid_request'),
                        ),
                    );
                    return;
                }
                let stopState: SessionOwnerControlTokenState | undefined;
                let finishStopResponse: (() => void) | undefined;
                let restoreSocket: (() => void) | undefined;
                try {
                    stopState = request.method === 'session.stop' ? this.requireToken(request.params.token) : undefined;
                    if (stopState !== undefined) {
                        stopState.pendingStopResponses += 1;
                        const trackedState = stopState;
                        finishStopResponse = trackSessionOwnerControlStopResponse(socket, () =>
                            finishSessionOwnerControlStopResponse(trackedState),
                        );
                    }
                    restoreSocket =
                        request.method === 'session.release' || request.method === 'session.stop'
                            ? preserveAuthenticatedSessionControlSocketDuringClose(socket)
                            : undefined;
                    if (restoreSocket !== undefined) socket.once('close', restoreSocket);
                    const result = await this.dispatch(request);
                    socket.write(
                        encodeSessionOwnerControlFrame({
                            version: SESSION_OWNER_CONTROL_PROTOCOL_VERSION,
                            id: request.id,
                            ok: true,
                            result,
                        }),
                        () => {
                            finishStopResponse?.();
                            restoreSocket?.();
                        },
                    );
                } catch (error: unknown) {
                    const code = error instanceof SessionOwnerControlServerError ? error.code : 'internal_error';
                    const message =
                        error instanceof SessionOwnerControlServerError
                            ? error.message
                            : 'owner control request failed';
                    socket.write(
                        encodeSessionOwnerControlFrame(sessionOwnerControlErrorResponse(request.id, code, message)),
                        () => {
                            finishStopResponse?.();
                            restoreSocket?.();
                        },
                    );
                }
            },
            onError: () => socket.destroy(),
        });
    }

    private async dispatch(request: SessionOwnerControlRequest): Promise<unknown> {
        switch (request.method) {
            case 'session.acquire':
                return this.acquire(request.params);
            case 'session.stop':
                return this.stop(request.params.token);
            case 'session.release':
                return this.release(request.params.token);
        }
    }

    private async acquire(params: Extract<SessionOwnerControlRequest, { method: 'session.acquire' }>['params']) {
        if (params.sessionId !== this.sessionId) throw new SessionOwnerControlServerError('token_invalid');
        const existing = this.byOperation.get(params.operationId);
        if (existing !== undefined) {
            if (
                existing.requestId !== params.requestId ||
                existing.token.timeoutMs !== params.timeoutMs ||
                existing.barrierKind !== (params.barrierKind ?? 'all_mutations')
            ) {
                throw new SessionOwnerControlServerError('token_invalid');
            }
            return { token: existing.token };
        }
        const pending = this.pendingByOperation.get(params.operationId);
        if (pending !== undefined) {
            const state = await pending;
            assertSessionOwnerControlAcquireMatches(state, params);
            return { token: state.token };
        }
        const creation = this.createTokenState(params);
        this.pendingByOperation.set(params.operationId, creation);
        try {
            const state = await creation;
            return { token: state.token };
        } finally {
            if (this.pendingByOperation.get(params.operationId) === creation) {
                this.pendingByOperation.delete(params.operationId);
            }
        }
    }

    private async createTokenState(
        params: Extract<SessionOwnerControlRequest, { method: 'session.acquire' }>['params'],
    ): Promise<SessionOwnerControlTokenState> {
        const access = await this.host.acquire(this.sessionId);
        const barrierKind = params.barrierKind ?? 'all_mutations';
        let acquisition: SessionOwnerControlTokenState['acquisition'];
        let childSpawnBarrier: SessionOwnerControlTokenState['childSpawnBarrier'];
        try {
            if (barrierKind === 'child_spawn_only') {
                childSpawnBarrier = await this.host.acquireChildSpawnBarrier({
                    sessionId: this.sessionId,
                    token: access,
                    requestId: params.requestId,
                    operationId: params.operationId,
                    timeoutMs: params.timeoutMs,
                    onReleased: () => this.evictOperation(params.operationId),
                });
            } else {
                acquisition = await this.service.acquireExact(
                    {
                        sessionId: this.sessionId,
                        requestId: params.requestId,
                        operationId: params.operationId,
                        ownerId: access.ownerId,
                        ownerEpoch: access.epoch,
                        timeoutMs: params.timeoutMs,
                    },
                    () => this.evictOperation(params.operationId),
                );
            }
        } catch (error: unknown) {
            if (error instanceof SessionControlFencedError) throw new SessionOwnerControlServerError('owner_fenced');
            throw error;
        }
        const token = createSessionOwnerControlToken({
            operationId: params.operationId,
            sessionId: this.sessionId,
            kind: params.kind,
            ownerId: access.ownerId,
            ownerEpoch: access.epoch,
            timeoutMs: params.timeoutMs,
        });
        const state: SessionOwnerControlTokenState = {
            token,
            requestId: params.requestId,
            barrierKind,
            acquisition,
            childSpawnBarrier,
            pendingStopResponses: 0,
            stopResponseWaiters: [],
        };
        this.byOperation.set(params.operationId, state);
        this.byValue.set(token.value, state);
        return state;
    }

    private async stop(token: SessionOwnerControlToken) {
        const state = this.requireToken(token);
        if (state.acquisition === undefined) throw new SessionOwnerControlServerError('token_invalid');
        return this.service.stopAcquired(state.acquisition);
    }

    private async release(token: SessionOwnerControlToken) {
        const state = this.requireToken(token);
        await waitForSessionOwnerControlStopResponses(state);
        if (state.acquisition !== undefined) await this.service.releaseAcquired(state.acquisition);
        else await state.childSpawnBarrier?.release();
        this.byOperation.delete(state.token.operationId);
        this.byValue.delete(state.token.value);
        return { released: true };
    }

    private requireToken(token: SessionOwnerControlToken): SessionOwnerControlTokenState {
        const state = this.byValue.get(token.value);
        if (state === undefined || !matchesSessionOwnerControlToken(state.token, token)) {
            throw new SessionOwnerControlServerError('token_invalid');
        }
        return state;
    }

    private evictOperation(operationId: string): void {
        const state = this.byOperation.get(operationId);
        if (state === undefined) return;
        this.byOperation.delete(operationId);
        this.byValue.delete(state.token.value);
    }
}
