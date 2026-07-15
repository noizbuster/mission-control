import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LocalLibsqlDb, openLocalLibsqlDb } from '../db/local-libsql-db';
import {
    SessionControlFencedError,
    SessionControlHost,
    type SessionControlHostPublisher,
} from './session-control-host';
import { acquireSessionControlLease } from './session-control-lease';
import type { SessionControlLeaseRenewer } from './session-control-lease-renewer';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_IDENTITY = '5'.repeat(64);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SessionControlHost', () => {
    it('publishes before attaching and closes only after the final attachment settles', async () => {
        const runtime = await createRuntime();
        const trace: string[] = [];
        const close = vi.fn(async () => {
            trace.push('close');
        });
        const host = createHost(runtime, {
            onPublish: () => trace.push('publish'),
            close,
        });

        const attachment = await host.attachEntity({
            sessionId: 'session-host-order',
            kind: 'run',
            entityId: 'run-one',
            handles: [],
        });
        trace.push('durable-active');

        expect(trace).toEqual(['publish', 'durable-active']);
        expect(host.classify('session-host-order')).toEqual({ kind: 'owned', ownerId: 'process-owner', epoch: 1 });
        expect(close).not.toHaveBeenCalled();

        await attachment.detach();

        expect(trace).toEqual(['publish', 'durable-active', 'close']);
        expect(host.classify('session-host-order')).toEqual({ kind: 'absent' });
        runtime.close();
    });

    it('self-fences atomically, denies admission, aborts handles, and waits to close', async () => {
        const runtime = await createRuntime();
        let onFenced: (() => void | Promise<void>) | undefined;
        let releaseSettlement: (() => void) | undefined;
        const settled = new Promise<void>((resolve) => {
            releaseSettlement = resolve;
        });
        const abort = vi.fn(async () => undefined);
        const close = vi.fn(async () => undefined);
        const host = createHost(runtime, {
            close,
            startRenewer: (input) => {
                onFenced = input.onFenced;
                return { stop: vi.fn() };
            },
        });
        const attachment = await host.attachEntity({
            sessionId: 'session-host-fence',
            kind: 'job',
            entityId: 'job-one',
            handles: [{ kind: 'job', handleId: 'job:job-one', abort, settled }],
        });

        const fencing = onFenced?.();

        expect(host.classify('session-host-fence')).toEqual({ kind: 'fenced', ownerId: 'process-owner', epoch: 1 });
        expect(host.isAdmissionAllowed('session-host-fence')).toBe(false);
        expect(abort).toHaveBeenCalledOnce();
        await expect(
            host.attachEntity({
                sessionId: 'session-host-fence',
                kind: 'input',
                entityId: 'input-late',
                handles: [],
            }),
        ).rejects.toBeInstanceOf(SessionControlFencedError);
        expect(close).not.toHaveBeenCalled();

        releaseSettlement?.();
        await attachment.detach();
        await fencing;

        expect(close).toHaveBeenCalledOnce();
        runtime.close();
    });

    it('bounds process-host teardown when a handle never settles', async () => {
        const runtime = await createRuntime();
        const close = vi.fn(async () => undefined);
        const host = createHost(runtime, { close, fenceGraceMs: 5 });
        await host.attachEntity({
            sessionId: 'session-host-stuck',
            kind: 'job',
            entityId: 'job-stuck',
            handles: [
                {
                    kind: 'job',
                    handleId: 'job:stuck',
                    abort: () => new Promise<void>(() => undefined),
                    settled: new Promise<void>(() => undefined),
                },
            ],
        });

        await host.close();

        expect(close).toHaveBeenCalledOnce();
        expect(host.classify('session-host-stuck')).toEqual({ kind: 'absent' });
        await expect(
            host.attachEntity({
                sessionId: 'session-after-close',
                kind: 'input',
                entityId: 'input-after-close',
                handles: [],
            }),
        ).rejects.toBeInstanceOf(SessionControlFencedError);
        runtime.close();
    });
});

function createHost(
    runtime: LocalLibsqlDb,
    options: {
        readonly onPublish?: () => void;
        readonly close?: () => Promise<void>;
        readonly startRenewer?: (input: {
            readonly renew: () => Promise<boolean>;
            readonly onFenced: () => void | Promise<void>;
        }) => SessionControlLeaseRenewer;
        readonly fenceGraceMs?: number;
    } = {},
): SessionControlHost {
    const publisher: SessionControlHostPublisher = async (input) => {
        options.onPublish?.();
        const lease = (
            await acquireSessionControlLease({
                runtime,
                dbIdentity: DB_IDENTITY,
                sessionId: input.sessionId,
                ownerId: input.ownerId,
                nonceHash: createHash('sha256').update(input.sessionId).digest('hex'),
                pid: process.pid,
                processStartId: 'test-process',
                nowWallMs: 1_000,
            })
        ).lease;
        return {
            lease,
            owner: {
                endpoint: `/tmp/${input.sessionId}.sock`,
                epoch: lease.epoch,
                ownerId: lease.ownerId,
                registryPath: `/tmp/${input.sessionId}.json`,
                renew: async () => true,
                close: options.close ?? (async () => undefined),
            },
        };
    };
    return new SessionControlHost({
        runtime,
        dbIdentity: DB_IDENTITY,
        ownerId: 'process-owner',
        publisher,
        ...(options.startRenewer !== undefined ? { startRenewer: options.startRenewer } : {}),
        ...(options.fenceGraceMs !== undefined ? { fenceGraceMs: options.fenceGraceMs } : {}),
    });
}

async function createRuntime(): Promise<LocalLibsqlDb> {
    const directory = await mkdtemp(join(tmpdir(), 'mctrl-session-control-host-'));
    directories.push(directory);
    return openLocalLibsqlDb({ url: `file:${join(directory, 'mission-control.db')}` });
}
