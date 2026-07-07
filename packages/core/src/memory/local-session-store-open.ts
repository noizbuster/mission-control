import type { AbgGraphSnapshot, AgentEvent, AgentEventEnvelope, AgentSnapshot } from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline.js';
import { resolveMissionControlDataDir } from './data-dir.js';
import { type JsonlSessionEventIdFactory, JsonlSessionEventStoreError } from './jsonl-session-event-store.js';
import { releaseSessionLock } from './jsonl-session-files.js';
import {
    acquireJsonlSessionLock,
    DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS,
    heartbeatJsonlSessionLock,
    type JsonlSessionLockLease,
} from './jsonl-session-lock.js';
import { ensureLocalSessionDatabase } from './local-session-store-database.js';
import { localSessionDbUrl, parseLocalSessionId } from './local-session-store-paths.js';
import type { MemoryStore, SessionCompactionRecordInput } from './memory-store.js';
import { SqliteSessionEventStore } from './sqlite-session-event-store.js';
import type { FileHandle } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type LocalSessionEventStore = MemoryStore & {
    readonly sessionId: string;
    readonly appendEnvelopeWithStoreSequence: (envelope: AgentEventEnvelope) => Promise<void>;
    readonly close: () => Promise<void> | void;
};

export type OpenLocalSessionEventStoreOptions = {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
    readonly lockOwnerId?: string;
    readonly lockPid?: number;
    readonly lockStaleAfterMs?: number;
    readonly lockHeartbeatIntervalMs?: number;
};

export async function openLocalSessionEventStore(
    options: OpenLocalSessionEventStoreOptions,
): Promise<LocalSessionEventStore> {
    const dataDir = options.dataDir ?? resolveMissionControlDataDir();
    const sessionId = parseLocalSessionId(options.sessionId);
    const now = options.now ?? (() => new Date().toISOString());
    const lock = await acquireLocalSessionLock({
        dataDir,
        sessionId,
        now,
        ...(options.lockOwnerId !== undefined ? { lockOwnerId: options.lockOwnerId } : {}),
        ...(options.lockPid !== undefined ? { lockPid: options.lockPid } : {}),
        ...(options.lockStaleAfterMs !== undefined ? { lockStaleAfterMs: options.lockStaleAfterMs } : {}),
    });
    let store: SqliteSessionEventStore | undefined;
    try {
        await ensureLocalSessionDatabase({ dataDir, now });
        store = await SqliteSessionEventStore.open({
            url: localSessionDbUrl(dataDir),
            sessionId,
            now,
            ...(options.createEventId !== undefined ? { createEventId: options.createEventId } : {}),
        });
        return new LockedLocalSessionEventStore({
            store,
            lockPath: lock.lockPath,
            lockHandle: lock.lockHandle,
            lockLease: lock.lockLease,
            now,
            lockHeartbeatIntervalMs:
                options.lockHeartbeatIntervalMs ??
                Math.max(1_000, (options.lockStaleAfterMs ?? DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS) / 3),
        });
    } catch (error: unknown) {
        await store?.close();
        await releaseSessionLock(lock.lockHandle, lock.lockPath);
        throw error;
    }
}

type LocalSessionLock = {
    readonly lockPath: string;
    readonly lockHandle: FileHandle;
    readonly lockLease: JsonlSessionLockLease;
};

async function acquireLocalSessionLock(input: {
    readonly dataDir: string;
    readonly sessionId: string;
    readonly now: () => string;
    readonly lockOwnerId?: string;
    readonly lockPid?: number;
    readonly lockStaleAfterMs?: number;
}): Promise<LocalSessionLock> {
    const sessionsDir = join(input.dataDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const lockPath = join(sessionsDir, `${input.sessionId}.lock`);
    const acquired = await acquireJsonlSessionLock({
        sessionId: input.sessionId,
        lockPath,
        now: input.now,
        ...(input.lockOwnerId !== undefined ? { ownerId: input.lockOwnerId } : {}),
        ...(input.lockPid !== undefined ? { pid: input.lockPid } : {}),
        ...(input.lockStaleAfterMs !== undefined ? { staleAfterMs: input.lockStaleAfterMs } : {}),
    });
    return { lockPath, lockHandle: acquired.lockHandle, lockLease: acquired.lockLease };
}

class LockedLocalSessionEventStore implements LocalSessionEventStore {
    readonly sessionId: string;
    private readonly store: SqliteSessionEventStore;
    private readonly lockPath: string;
    private readonly lockHandle: FileHandle;
    private readonly now: () => string;
    private lockLease: JsonlSessionLockLease;
    private lockRefreshQueue: Promise<void> = Promise.resolve();
    private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    private heartbeatFailure: unknown;
    private closed = false;

    constructor(input: {
        readonly store: SqliteSessionEventStore;
        readonly lockPath: string;
        readonly lockHandle: FileHandle;
        readonly lockLease: JsonlSessionLockLease;
        readonly now: () => string;
        readonly lockHeartbeatIntervalMs: number;
    }) {
        this.store = input.store;
        this.sessionId = input.store.sessionId;
        this.lockPath = input.lockPath;
        this.lockHandle = input.lockHandle;
        this.lockLease = input.lockLease;
        this.now = input.now;
        this.startHeartbeat(input.lockHeartbeatIntervalMs);
    }

    async append(event: AgentEvent): Promise<void> {
        await this.waitForLockRefresh();
        await this.store.append(event);
    }

    async appendEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        await this.waitForLockRefresh();
        await this.store.appendEnvelope(envelope);
    }

    async appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void> {
        await this.waitForLockRefresh();
        await this.store.appendEnvelopeWithStoreSequence(envelope);
    }

    async getEvents(sessionId: string): Promise<readonly AgentEvent[]> {
        await this.waitForLockRefresh();
        return this.store.getEvents(sessionId);
    }

    async getSnapshot(sessionId: string): Promise<AgentSnapshot> {
        await this.waitForLockRefresh();
        return this.store.getSnapshot(sessionId);
    }

    async getGraphSnapshot(sessionId: string, graphId: string): Promise<AbgGraphSnapshot> {
        await this.waitForLockRefresh();
        return this.store.getGraphSnapshot(sessionId, graphId);
    }

    async getTimeline(sessionId: string): Promise<readonly AbgTimelineEntry[]> {
        await this.waitForLockRefresh();
        return this.store.getTimeline(sessionId);
    }

    async compact(input: SessionCompactionRecordInput): Promise<AgentEvent> {
        await this.waitForLockRefresh();
        return this.store.compact(input);
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.stopHeartbeat();
        await this.lockRefreshQueue;
        this.closed = true;
        try {
            await this.store.close();
        } finally {
            await releaseSessionLock(this.lockHandle, this.lockPath);
        }
    }

    private startHeartbeat(intervalMs: number): void {
        this.heartbeatTimer = setInterval(() => {
            this.lockRefreshQueue = this.lockRefreshQueue
                .then(async () => {
                    this.ensureOpen();
                    const acquired = await heartbeatJsonlSessionLock({
                        lockHandle: this.lockHandle,
                        lockPath: this.lockPath,
                        lockLease: this.lockLease,
                        now: this.now,
                    });
                    this.lockLease = acquired.lockLease;
                })
                .catch((error: unknown) => {
                    this.heartbeatFailure = error;
                    this.stopHeartbeat();
                });
        }, intervalMs);
        this.heartbeatTimer.unref?.();
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private async waitForLockRefresh(): Promise<void> {
        await this.lockRefreshQueue;
        this.ensureOpen();
    }

    private ensureOpen(): void {
        if (this.heartbeatFailure !== undefined) {
            throw this.heartbeatFailure;
        }
        if (this.closed) {
            throw new JsonlSessionEventStoreError({
                code: 'write_failed',
                message: `Local session store ${this.sessionId} is already closed`,
                sessionId: this.sessionId,
                path: this.lockPath,
            });
        }
    }
}
