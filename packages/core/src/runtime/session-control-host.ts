// allow: SIZE_OK -- HEAD 398 -> current 409 pure LOC; one leased session-control ownership and attachment state machine.
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db.js';
import { openLocalSessionEventStore } from '../memory/local-session-store.js';
import type { ObservabilityRedactor } from '../providers/observability-redactor.js';
import { acquireSessionChildSpawnBarrier, type SessionChildSpawnBarrier } from './session-child-spawn-barrier.js';
import {
    assertUniqueSessionControlHandles,
    type SessionControlAccessToken,
    type SessionControlAttachedHandle,
    type SessionControlAttachment,
    type SessionControlEntityKind,
    type SessionControlEntitySnapshot,
    SessionControlFencedError,
    type SessionControlHostPublisher,
    type SessionControlStopContext,
} from './session-control-host-types.js';
import {
    readSessionControlLease,
    runWithSessionControlLeaseFence,
    type SessionControlLease,
} from './session-control-lease.js';
import { type SessionControlLeaseRenewer, startSessionControlLeaseRenewer } from './session-control-lease-renewer.js';
import { type PosixSessionControlOwner, publishPosixSessionControlOwner } from './session-control-owner-posix.js';
import { publishWindowsSessionControlOwner } from './session-control-owner-windows.js';
import { sessionControlTransportForPlatform } from './session-control-platform.js';
import type { ResolvePosixSessionControlPathsInput } from './session-control-registry-paths.js';
import { SessionOwnerControlServer } from './session-owner-control-server.js';
import { SessionStopService } from './session-stop-service.js';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const SESSION_CONTROL_FENCE_GRACE_MS = 1_000;

export * from './session-control-host-types.js';

type SessionEntry = {
    readonly sessionId: string;
    readonly owner: PosixSessionControlOwner;
    readonly lease: SessionControlLease;
    readonly attachments: Map<string, SessionControlEntitySnapshot>;
    holds: number;
    renewer: SessionControlLeaseRenewer | undefined;
    renewal: Promise<boolean> | undefined;
    state: 'owned' | 'child_spawn_blocked' | 'stopping' | 'fenced' | 'closing';
    closePromise: Promise<void> | undefined;
};

export class SessionControlHost {
    private readonly runtime: LocalLibsqlWriteTarget;
    private readonly dbIdentity: string;
    private readonly ownerId: string;
    private readonly publisher: SessionControlHostPublisher;
    private readonly startRenewer: typeof startSessionControlLeaseRenewer;
    private readonly fenceGraceMs: number;
    private readonly dataDir: string | undefined;
    private readonly observabilityRedactor: ObservabilityRedactor | Promise<ObservabilityRedactor> | undefined;
    private readonly ownerPaths: Omit<ResolvePosixSessionControlPathsInput, 'dbIdentity' | 'sessionId'> | undefined;
    private readonly ownerControlDeadline:
        | {
              readonly now?: () => Date;
              readonly monotonicNow?: () => number;
              readonly schedule?: (callback: () => void | Promise<void>, delayMs: number) => unknown;
              readonly cancel?: (timer: unknown) => void;
          }
        | undefined;
    private readonly entries = new Map<string, Promise<SessionEntry>>();
    private readonly resolvedEntries = new Map<string, SessionEntry>();
    private closed = false;

    constructor(input: {
        readonly runtime: LocalLibsqlWriteTarget;
        readonly dbIdentity: string;
        readonly ownerId?: string;
        readonly publisher?: SessionControlHostPublisher;
        readonly startRenewer?: typeof startSessionControlLeaseRenewer;
        readonly fenceGraceMs?: number;
        readonly dataDir?: string;
        readonly observabilityRedactor?: ObservabilityRedactor | Promise<ObservabilityRedactor>;
        readonly ownerPaths?: Omit<ResolvePosixSessionControlPathsInput, 'dbIdentity' | 'sessionId'>;
        readonly ownerControlDeadline?: {
            readonly now?: () => Date;
            readonly monotonicNow?: () => number;
            readonly schedule?: (callback: () => void | Promise<void>, delayMs: number) => unknown;
            readonly cancel?: (timer: unknown) => void;
        };
    }) {
        this.runtime = input.runtime;
        this.dbIdentity = input.dbIdentity;
        this.ownerId = input.ownerId ?? `process-${process.pid}-${randomUUID()}`;
        this.publisher = input.publisher ?? defaultPublisher;
        this.startRenewer = input.startRenewer ?? startSessionControlLeaseRenewer;
        this.fenceGraceMs = input.fenceGraceMs ?? SESSION_CONTROL_FENCE_GRACE_MS;
        this.dataDir = input.dataDir;
        this.observabilityRedactor = input.observabilityRedactor;
        this.ownerPaths = input.ownerPaths;
        this.ownerControlDeadline = input.ownerControlDeadline;
    }

    classify(
        sessionId: string,
    ):
        | { readonly kind: 'absent' }
        | ({ readonly kind: 'owned' | 'child_spawn_blocked' | 'stopping' | 'fenced' } & SessionControlAccessToken) {
        const pending = this.entries.get(sessionId);
        if (pending === undefined) return { kind: 'absent' };
        const entry = this.resolvedEntries.get(sessionId);
        if (entry === undefined || entry.state === 'closing') return { kind: 'absent' };
        return { kind: entry.state, ownerId: entry.lease.ownerId, epoch: entry.lease.epoch };
    }

    isAdmissionAllowed(sessionId: string): boolean {
        const classification = this.classify(sessionId);
        return (
            classification.kind === 'absent' ||
            classification.kind === 'owned' ||
            classification.kind === 'child_spawn_blocked'
        );
    }

    assertChildSpawnAllowed(sessionId: string): void {
        const classification = this.classify(sessionId);
        if (classification.kind === 'stopping' || classification.kind === 'child_spawn_blocked') {
            throw new SessionControlFencedError('session child spawning is blocked');
        }
    }

    async acquire(sessionId: string): Promise<SessionControlAccessToken> {
        const entry = await this.ensureEntry(sessionId);
        this.assertGeneralAdmission(entry);
        return { ownerId: entry.lease.ownerId, epoch: entry.lease.epoch };
    }

    async attachEntity(input: {
        readonly sessionId: string;
        readonly kind: SessionControlEntityKind;
        readonly entityId: string;
        readonly handles: readonly SessionControlAttachedHandle[];
    }): Promise<SessionControlAttachment> {
        const entry = await this.ensureEntry(input.sessionId);
        this.assertGeneralAdmission(entry);
        const key = `${input.kind}:${input.entityId}`;
        if (entry.attachments.has(key)) throw new TypeError(`session control entity already attached: ${key}`);
        assertUniqueSessionControlHandles(input.handles);
        const record: SessionControlEntitySnapshot = {
            key,
            kind: input.kind,
            entityId: input.entityId,
            handles: [...input.handles],
        };
        entry.attachments.set(key, record);
        let detached = false;
        return {
            detach: async () => {
                if (detached) return;
                detached = true;
                entry.attachments.delete(key);
                await this.closeIfQuiescent(entry);
            },
        };
    }

    async detachEntity(sessionId: string, kind: SessionControlEntityKind, entityId: string): Promise<void> {
        const pending = this.entries.get(sessionId);
        if (pending === undefined) return;
        const entry = await pending;
        entry.attachments.delete(`${kind}:${entityId}`);
        await this.closeIfQuiescent(entry);
    }

    async stopSnapshot(
        sessionId: string,
        token: SessionControlAccessToken,
    ): Promise<{
        readonly lease: SessionControlLease;
        readonly attachments: readonly SessionControlEntitySnapshot[];
        readonly release: () => Promise<void>;
    }> {
        const entry = await this.ensureEntry(sessionId);
        this.assertOwned(entry);
        this.assertToken(entry, token);
        entry.state = 'stopping';
        try {
            await runWithSessionControlLeaseFence({
                runtime: this.runtime,
                lease: entry.lease,
                nowWallMs: Date.now(),
                write: async () => undefined,
            });
        } catch (error: unknown) {
            void this.fenceEntry(entry).catch(() => undefined);
            throw error;
        }
        entry.holds += 1;
        let released = false;
        return {
            lease: entry.lease,
            attachments: [...entry.attachments.values()],
            release: async () => {
                if (released) return;
                released = true;
                entry.holds = Math.max(0, entry.holds - 1);
                await this.closeIfQuiescent(entry);
            },
        };
    }

    async acquireChildSpawnBarrier(input: {
        readonly sessionId: string;
        readonly token: SessionControlAccessToken;
        readonly requestId: string;
        readonly operationId: string;
        readonly timeoutMs: number;
        readonly onReleased?: () => void;
    }): Promise<SessionChildSpawnBarrier> {
        const entry = await this.ensureEntry(input.sessionId);
        this.assertOwned(entry);
        this.assertToken(entry, input.token);
        entry.state = 'child_spawn_blocked';
        entry.holds += 1;
        let stateReleased = false;
        const releaseState = async (): Promise<void> => {
            if (stateReleased) return;
            stateReleased = true;
            if (entry.state === 'child_spawn_blocked') entry.state = 'owned';
            entry.holds = Math.max(0, entry.holds - 1);
            await this.closeIfQuiescent(entry);
        };
        try {
            return await acquireSessionChildSpawnBarrier({
                runtime: this.runtime,
                lease: entry.lease,
                requestId: input.requestId,
                operationId: input.operationId,
                timeoutMs: input.timeoutMs,
                releaseState,
                ...(input.onReleased !== undefined ? { onReleased: input.onReleased } : {}),
                ...(this.ownerControlDeadline?.now !== undefined ? { now: this.ownerControlDeadline.now } : {}),
                ...(this.ownerControlDeadline?.monotonicNow !== undefined
                    ? { monotonicNow: this.ownerControlDeadline.monotonicNow }
                    : {}),
                ...(this.ownerControlDeadline?.schedule !== undefined
                    ? { schedule: this.ownerControlDeadline.schedule }
                    : {}),
                ...(this.ownerControlDeadline?.cancel !== undefined
                    ? { cancel: this.ownerControlDeadline.cancel }
                    : {}),
            });
        } catch (error: unknown) {
            await releaseState();
            throw error;
        }
    }

    async release(sessionId: string): Promise<void> {
        const pending = this.entries.get(sessionId);
        if (pending === undefined) return;
        await this.closeIfQuiescent(await pending);
    }

    async cancelStop(sessionId: string, token: SessionControlAccessToken): Promise<void> {
        const pending = this.entries.get(sessionId);
        if (pending === undefined) return;
        const entry = await pending;
        if (entry.lease.ownerId !== token.ownerId || entry.lease.epoch !== token.epoch) {
            throw new SessionControlFencedError('session control token no longer owns the session');
        }
        if (entry.state === 'stopping') entry.state = 'owned';
    }

    async fenceSession(sessionId: string): Promise<void> {
        const pending = this.entries.get(sessionId);
        if (pending === undefined) return;
        await this.fenceEntry(await pending);
    }

    async close(): Promise<void> {
        this.closed = true;
        const entries = await Promise.all(this.entries.values());
        await Promise.all(entries.map((entry) => this.fenceEntry(entry)));
    }

    private async ensureEntry(sessionId: string): Promise<SessionEntry> {
        if (this.closed) throw new SessionControlFencedError('session control host is closed');
        const existing = this.entries.get(sessionId);
        if (existing !== undefined) return existing;
        const pending = this.publishEntry(sessionId);
        this.entries.set(sessionId, pending);
        void pending.then((entry) => this.resolvedEntries.set(sessionId, entry)).catch(() => undefined);
        pending.catch(() => {
            if (this.entries.get(sessionId) === pending) this.entries.delete(sessionId);
            this.resolvedEntries.delete(sessionId);
        });
        return pending;
    }

    private async publishEntry(sessionId: string): Promise<SessionEntry> {
        let controlServer: SessionOwnerControlServer | undefined;
        const pendingSockets: Array<{ readonly socket: Duplex; readonly initialBytes: Buffer }> = [];
        const onAuthenticated = (socket: Duplex, initialBytes: Buffer): void => {
            if (controlServer === undefined) {
                pendingSockets.push({ socket, initialBytes });
                return;
            }
            controlServer.accept(socket, initialBytes);
        };
        const published = await this.publisher({
            runtime: this.runtime,
            dbIdentity: this.dbIdentity,
            sessionId,
            ownerId: this.ownerId,
            onAuthenticated,
            ...(this.ownerPaths !== undefined ? { paths: this.ownerPaths } : {}),
        });
        const entry: SessionEntry = {
            sessionId,
            owner: published.owner,
            lease: published.lease,
            attachments: new Map(),
            holds: 0,
            renewer: undefined,
            renewal: undefined,
            state: 'owned',
            closePromise: undefined,
        };
        if (this.dataDir !== undefined) {
            const dataDir = this.dataDir;
            const observabilityRedactor = await this.observabilityRedactor;
            controlServer = new SessionOwnerControlServer({
                sessionId,
                host: this,
                service: new SessionStopService({
                    runtime: this.runtime,
                    host: this,
                    missionRoot: this.dataDir,
                    openStore: (targetSessionId) =>
                        openLocalSessionEventStore({
                            dataDir,
                            sessionId: targetSessionId,
                            ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
                        }),
                    ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
                    ...(this.ownerControlDeadline?.now !== undefined ? { now: this.ownerControlDeadline.now } : {}),
                    ...(this.ownerControlDeadline?.monotonicNow !== undefined
                        ? { monotonicNow: this.ownerControlDeadline.monotonicNow }
                        : {}),
                    ...(this.ownerControlDeadline?.schedule !== undefined
                        ? { deadlineSchedule: this.ownerControlDeadline.schedule }
                        : {}),
                    ...(this.ownerControlDeadline?.cancel !== undefined
                        ? { deadlineCancel: this.ownerControlDeadline.cancel }
                        : {}),
                }),
            });
            for (const pending of pendingSockets.splice(0)) controlServer.accept(pending.socket, pending.initialBytes);
        } else {
            for (const pending of pendingSockets.splice(0)) pending.socket.destroy();
        }
        entry.renewer = this.startRenewer({
            renew: () => this.renewEntry(entry),
            onFenced: () => this.fenceEntry(entry),
        });
        return entry;
    }

    private async fenceEntry(entry: SessionEntry): Promise<void> {
        if (entry.state === 'closing') return entry.closePromise;
        entry.state = 'fenced';
        entry.renewer?.stop();
        const context: SessionControlStopContext = { kind: 'lease_fenced', timestamp: new Date().toISOString() };
        const settlements = [...entry.attachments.values()].flatMap((attachment) =>
            attachment.handles.map(async (handle) => {
                await handle.abort(context);
                await handle.settled;
            }),
        );
        await Promise.race([Promise.allSettled(settlements), delay(this.fenceGraceMs)]);
        entry.attachments.clear();
        entry.holds = 0;
        await this.closeIfQuiescent(entry);
    }

    private async closeIfQuiescent(entry: SessionEntry): Promise<void> {
        if (entry.attachments.size > 0 || entry.holds > 0 || entry.state === 'closing') return entry.closePromise;
        entry.state = 'closing';
        entry.renewer?.stop();
        entry.closePromise = (async () => {
            await entry.renewal?.catch(() => false);
            await entry.owner.close();
        })().finally(() => {
            this.entries.delete(entry.sessionId);
            this.resolvedEntries.delete(entry.sessionId);
        });
        return entry.closePromise;
    }

    private async renewEntry(entry: SessionEntry): Promise<boolean> {
        if (entry.state !== 'owned' && entry.state !== 'child_spawn_blocked' && entry.state !== 'stopping') {
            return false;
        }
        const renewal = entry.owner.renew();
        entry.renewal = renewal;
        try {
            return await renewal;
        } finally {
            if (entry.renewal === renewal) entry.renewal = undefined;
        }
    }

    private assertOwned(entry: SessionEntry): void {
        if (entry.state !== 'owned') throw new SessionControlFencedError();
    }

    private assertGeneralAdmission(entry: SessionEntry): void {
        if (entry.state !== 'owned' && entry.state !== 'child_spawn_blocked') {
            throw new SessionControlFencedError();
        }
    }

    private assertToken(entry: SessionEntry, token: SessionControlAccessToken): void {
        this.assertOwned(entry);
        if (entry.lease.ownerId !== token.ownerId || entry.lease.epoch !== token.epoch) {
            throw new SessionControlFencedError('session control token no longer owns the session');
        }
    }
}

async function defaultPublisher(input: Parameters<SessionControlHostPublisher>[0]) {
    const owner =
        sessionControlTransportForPlatform(process.platform) === 'windows_proxy'
            ? await publishWindowsSessionControlOwner(input)
            : await publishPosixSessionControlOwner(input);
    const lease = await readSessionControlLease(input.runtime, input.dbIdentity, input.sessionId);
    if (lease === undefined) throw new SessionControlFencedError('published owner has no durable lease');
    return { owner, lease };
}
