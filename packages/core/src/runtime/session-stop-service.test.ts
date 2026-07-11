import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LocalLibsqlDb, openLocalLibsqlDb } from '../db/local-libsql-db.js';
import {
    type LocalSessionEventStore,
    missionControlDbUrl,
    openLocalSessionEventStore,
} from '../memory/local-session-store.js';
import { SessionControlHost, type SessionControlHostPublisher } from './session-control-host.js';
import {
    acquireSessionControlLease,
    expireSessionControlLease,
    readSessionControlLease,
} from './session-control-lease.js';
import { readSessionControlOperation } from './session-control-operation.js';
import { appendFencedSessionStopEvent } from './session-stop-event-writer.js';
import { SessionStopService } from './session-stop-service.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_IDENTITY = '6'.repeat(64);
const directories: string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SessionStopService', () => {
    it('stops the exact blocked run, settles live handles, and emits one finalizer plus one marker', async () => {
        const fixture = await createFixture('session-blocked');
        await appendBlockedEvents(fixture.store, fixture.sessionId);
        await fixture.host.attachEntity({
            sessionId: fixture.sessionId,
            kind: 'run',
            entityId: 'run-blocked',
            handles: [
                {
                    kind: 'provider',
                    handleId: 'provider:blocked',
                    abort: () => undefined,
                    writeSettlement: async (client, context) => {
                        if (context.kind !== 'operator_stop') return;
                        await appendFencedSessionStopEvent({
                            client,
                            sessionId: fixture.sessionId,
                            event: {
                                type: 'run.interrupted',
                                timestamp: context.timestamp,
                                sessionId: fixture.sessionId,
                                run: {
                                    state: 'interrupted',
                                    runId: 'run-blocked',
                                    requestId: context.requestId,
                                    operationId: context.operationId,
                                    reason: 'operator_aborted',
                                },
                            },
                        });
                    },
                },
            ],
        });

        const token = await fixture.host.acquire(fixture.sessionId);
        const receipt = await fixture.service.stopExact({
            sessionId: fixture.sessionId,
            requestId: 'request-blocked',
            operationId: 'operation-blocked',
            ownerId: token.ownerId,
            ownerEpoch: token.epoch,
            timeoutMs: 1_000,
        });

        expect(receipt.outcome).toBe('interrupted');
        expect(receipt.affected).toMatchObject({ runs: 1, approvals: 1, sessionInputs: 1 });
        const events = await fixture.store.getEvents(fixture.sessionId);
        expect(events.filter((event) => event.type === 'run.interrupted')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'session.abort.completed')).toHaveLength(1);
        const session = await fixture.runtime.client.execute({
            sql: 'SELECT status, metadata_json FROM sessions WHERE session_id = ?',
            args: [fixture.sessionId],
        });
        expect(session.rows[0]).toMatchObject({ status: 'idle' });
        const metadataJsonColumn = 'metadata_json';
        expect(JSON.parse(String(session.rows[0]?.[metadataJsonColumn]))).toMatchObject({ lifecycleReason: 'aborted' });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
        await fixture.close();
    });

    it('returns already_idle for a truly empty session and emits no interrupted event', async () => {
        const fixture = await createFixture('session-empty');
        await fixture.store.append({
            type: 'session.started',
            timestamp: '2026-07-11T00:00:00.000Z',
            sessionId: fixture.sessionId,
        });
        const token = await fixture.host.acquire(fixture.sessionId);

        const receipt = await fixture.service.stopExact({
            sessionId: fixture.sessionId,
            requestId: 'request-empty',
            operationId: 'operation-empty',
            ownerId: token.ownerId,
            ownerEpoch: token.epoch,
            timeoutMs: 1_000,
        });

        expect(receipt.outcome).toBe('already_idle');
        const events = await fixture.store.getEvents(fixture.sessionId);
        expect(events.filter((event) => event.type === 'run.interrupted')).toHaveLength(0);
        expect(events.filter((event) => event.type === 'session.abort.completed')).toHaveLength(1);
        await fixture.close();
    });

    it('returns session_stopping to a concurrent exact stop', async () => {
        const fixture = await createFixture('session-concurrent-stop');
        const token = await fixture.host.acquire(fixture.sessionId);
        const activeStop = await fixture.host.stopSnapshot(fixture.sessionId, token);

        const second = await fixture.service.stopExact({
            sessionId: fixture.sessionId,
            requestId: 'request-concurrent-second',
            operationId: 'operation-concurrent-second',
            ownerId: token.ownerId,
            ownerEpoch: token.epoch,
            timeoutMs: 1_000,
        });

        expect(second).toMatchObject({ outcome: 'failed', errorCode: 'session_stopping' });
        await activeStop.release();
        await fixture.host.release(fixture.sessionId);
        await fixture.close();
    });

    it('times out a noncooperative job without a success marker or false terminal state', async () => {
        const fixture = await createFixture('session-timeout');
        await fixture.store.append({
            type: 'session.started',
            timestamp: '2026-07-11T00:00:00.000Z',
            sessionId: fixture.sessionId,
        });
        await fixture.runtime.client.execute({
            sql: 'INSERT INTO async_jobs (job_id,parent_session_id,child_session_id,status,queued_at,started_at,metadata_json) VALUES (?,?,?,?,?,?,?)',
            args: [
                'job-stuck',
                fixture.sessionId,
                null,
                'running',
                '2026-07-11T00:00:01.000Z',
                '2026-07-11T00:00:01.000Z',
                '{}',
            ],
        });
        const neverSettles = new Promise<void>(() => undefined);
        await fixture.host.attachEntity({
            sessionId: fixture.sessionId,
            kind: 'job',
            entityId: 'job-stuck',
            handles: [
                {
                    kind: 'job',
                    handleId: 'job:job-stuck',
                    abort: vi.fn(async () => neverSettles),
                },
            ],
        });
        const token = await fixture.host.acquire(fixture.sessionId);

        const receipt = await fixture.service.stopExact({
            sessionId: fixture.sessionId,
            requestId: 'request-timeout',
            operationId: 'operation-timeout',
            ownerId: token.ownerId,
            ownerEpoch: token.epoch,
            timeoutMs: 10,
        });

        expect(receipt).toMatchObject({ outcome: 'failed', errorCode: 'stop_timeout' });
        expect(
            await readSessionControlOperation(fixture.runtime, DB_IDENTITY, fixture.sessionId, 'operation-timeout'),
        ).toMatchObject({ status: 'timed_out' });
        const events = await fixture.store.getEvents(fixture.sessionId);
        expect(events.filter((event) => event.type === 'session.abort.completed')).toHaveLength(0);
        const job = await fixture.runtime.client.execute({
            sql: 'SELECT status, cancellation_reason FROM async_jobs WHERE job_id = ?',
            args: ['job-stuck'],
        });
        expect(job.rows[0]).toEqual({ status: 'running', cancellation_reason: 'operator_aborted' });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
        await fixture.close();
    });

    it('rejects an old epoch without mutating a newer run', async () => {
        const fixture = await createFixture('session-stale-epoch');
        await fixture.store.append({
            type: 'session.started',
            timestamp: '2026-07-11T00:00:00.000Z',
            sessionId: fixture.sessionId,
        });
        const token = await fixture.host.acquire(fixture.sessionId);
        const oldLease = await readSessionControlLease(fixture.runtime, DB_IDENTITY, fixture.sessionId);
        if (oldLease === undefined) throw new Error('old lease was not published');
        await expireSessionControlLease({ runtime: fixture.runtime, lease: oldLease, nowWallMs: Date.now() });
        await acquireSessionControlLease({
            runtime: fixture.runtime,
            dbIdentity: DB_IDENTITY,
            sessionId: fixture.sessionId,
            ownerId: 'new-owner',
            nonceHash: createHash('sha256').update('new-owner').digest('hex'),
            pid: process.pid,
            processStartId: 'new-process',
            nowWallMs: Date.now() + 1,
        });
        await fixture.store.append({
            type: 'run.started',
            timestamp: '2026-07-11T00:00:01.000Z',
            sessionId: fixture.sessionId,
            run: { command: 'run', state: 'running', runId: 'run-newer' },
        });

        const receipt = await fixture.service.stopExact({
            sessionId: fixture.sessionId,
            requestId: 'request-stale',
            operationId: 'operation-stale',
            ownerId: token.ownerId,
            ownerEpoch: token.epoch,
            timeoutMs: 100,
        });

        expect(receipt).toMatchObject({ outcome: 'failed', errorCode: 'session_owned_elsewhere' });
        const events = await fixture.store.getEvents(fixture.sessionId);
        expect(events.filter((event) => event.type === 'run.interrupted')).toHaveLength(0);
        expect(events.filter((event) => event.type === 'session.abort.completed')).toHaveLength(0);
        expect(events.at(-1)).toMatchObject({ type: 'run.started', run: { runId: 'run-newer' } });
        await fixture.close(false);
    });
});

async function createFixture(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly runtime: LocalLibsqlDb;
    readonly store: LocalSessionEventStore;
    readonly host: SessionControlHost;
    readonly service: SessionStopService;
    readonly close: (closeHost?: boolean) => Promise<void>;
}> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-session-stop-service-'));
    directories.push(dataDir);
    await mkdir(join(dataDir, '.omo'), { recursive: true });
    const runtime = await openLocalLibsqlDb({ url: missionControlDbUrl(dataDir) });
    const store = await openLocalSessionEventStore({ dataDir, sessionId });
    const publisher: SessionControlHostPublisher = async (input) => {
        const lease = (
            await acquireSessionControlLease({
                runtime,
                dbIdentity: DB_IDENTITY,
                sessionId: input.sessionId,
                ownerId: input.ownerId,
                nonceHash: createHash('sha256').update(randomUUID()).digest('hex'),
                pid: process.pid,
                processStartId: 'service-test',
                nowWallMs: Date.now(),
            })
        ).lease;
        return {
            lease,
            owner: {
                endpoint: `/tmp/${sessionId}.sock`,
                epoch: lease.epoch,
                ownerId: lease.ownerId,
                registryPath: `/tmp/${sessionId}.json`,
                renew: async () => true,
                close: async () => undefined,
            },
        };
    };
    const host = new SessionControlHost({
        runtime,
        dbIdentity: DB_IDENTITY,
        ownerId: 'service-owner',
        publisher,
        startRenewer: () => ({ stop: () => undefined }),
    });
    const service = new SessionStopService({
        runtime,
        host,
        missionRoot: dataDir,
        openStore: (targetSessionId) => openLocalSessionEventStore({ dataDir, sessionId: targetSessionId }),
    });
    return {
        sessionId,
        runtime,
        store,
        host,
        service,
        close: async (closeHost = true) => {
            if (closeHost) await host.close();
            await store.close();
            runtime.close();
        },
    };
}

async function appendBlockedEvents(store: LocalSessionEventStore, sessionId: string): Promise<void> {
    const events: readonly AgentEvent[] = [
        { type: 'session.started', timestamp: '2026-07-11T00:00:00.000Z', sessionId },
        {
            type: 'prompt.admitted',
            timestamp: '2026-07-11T00:00:01.000Z',
            sessionId,
            message: 'blocked prompt',
            transcript: {
                inputId: 'input-blocked',
                messageId: 'message-blocked',
                delivery: 'queue',
                visibility: 'pending',
            },
        },
        {
            type: 'approval.requested',
            timestamp: '2026-07-11T00:00:02.000Z',
            sessionId,
            approvalRecord: {
                approvalId: 'approval-blocked',
                requestId: 'approval-request',
                policyDecision: 'requires_approval',
                state: 'pending',
                subject: { kind: 'tool', id: 'tool-blocked' },
                requestedAt: '2026-07-11T00:00:02.000Z',
            },
        },
        {
            type: 'run.started',
            timestamp: '2026-07-11T00:00:03.000Z',
            sessionId,
            run: { command: 'run', state: 'running', runId: 'run-blocked' },
        },
        {
            type: 'run.blocked',
            timestamp: '2026-07-11T00:00:04.000Z',
            sessionId,
            run: { command: 'run', state: 'blocked_on_approval', runId: 'run-blocked', toolCallId: 'tool-blocked' },
        },
    ];
    for (const event of events) await store.append(event);
}
