import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db.js';
import type { SessionControlCallbackHandleKind } from './session-control-cancellation.js';
import type { SessionControlLease } from './session-control-lease.js';
import type { PosixSessionControlOwner } from './session-control-owner-posix.js';
import type { ResolvePosixSessionControlPathsInput } from './session-control-registry-paths.js';
import type { Duplex } from 'node:stream';

export type SessionControlEntityKind = 'run' | 'approval' | 'wait' | 'input' | 'mission_run' | 'job' | 'child';

export type SessionControlStopContext =
    | { readonly kind: 'lease_fenced'; readonly timestamp: string }
    | {
          readonly kind: 'operator_stop';
          readonly timestamp: string;
          readonly requestId: string;
          readonly operationId: string;
      };

export type SessionControlAttachedHandle = {
    readonly kind: SessionControlCallbackHandleKind;
    readonly handleId: string;
    readonly abort: (context: SessionControlStopContext) => void | Promise<void>;
    readonly settled?: Promise<void>;
    readonly writeSettlement?: (client: Client, context: SessionControlStopContext) => void | Promise<void>;
};

export type SessionControlHostPublisher = (input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly onAuthenticated?: (connection: Duplex, initialBytes: Buffer) => void;
    readonly paths?: Omit<ResolvePosixSessionControlPathsInput, 'dbIdentity' | 'sessionId'>;
}) => Promise<{ readonly owner: PosixSessionControlOwner; readonly lease: SessionControlLease }>;

export type SessionControlAccessToken = { readonly ownerId: string; readonly epoch: number };

export class SessionControlFencedError extends Error {
    constructor(message = 'session control owner is fenced') {
        super(message);
        this.name = 'SessionControlFencedError';
    }
}

export type SessionControlEntitySnapshot = {
    readonly key: string;
    readonly kind: SessionControlEntityKind;
    readonly entityId: string;
    readonly handles: readonly SessionControlAttachedHandle[];
};

export type SessionControlAttachment = { readonly detach: () => Promise<void> };

export function assertUniqueSessionControlHandles(handles: readonly SessionControlAttachedHandle[]): void {
    const ids = handles.map((handle) => handle.handleId);
    if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
        throw new TypeError('session control attachment handle ids must be nonempty and unique');
    }
}

import type { Client } from '@libsql/client';
