import type { Client } from '@libsql/client';

export type SessionControlCallbackHandleKind = 'provider' | 'tool' | 'command' | 'shell' | 'subagent' | 'job';

export type SessionControlCallbackSettlementInput = {
    readonly handleKind: SessionControlCallbackHandleKind;
    readonly handleId: string;
    readonly attemptedEventType: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly write?: (client: Client) => Promise<void>;
};

export type SessionControlCallbackSettlementResult = {
    readonly accepted: boolean;
    readonly allSettled: boolean;
};

export type SessionControlCallbackFence = {
    readonly operationId: string;
    readonly settle: (input: SessionControlCallbackSettlementInput) => Promise<SessionControlCallbackSettlementResult>;
};

export class SessionControlCallbackQuarantinedError extends Error {
    readonly name = 'SessionControlCallbackQuarantinedError';
}

export type SessionControlEpoch = {
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
    readonly callbackFence?: SessionControlCallbackFence;
};

export type SessionControlCancellation = {
    readonly signal: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
};
