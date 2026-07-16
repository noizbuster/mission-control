import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalSessionEventStore } from '../memory/local-session-store';
import { acquireSessionControlLease } from './session-control-lease';
import { openCanonicalRuntimeDb } from './local-runtime-db';
import { SessionControlHost } from './session-control-host';
import { appendFencedSessionStopEvent } from './session-stop-event-writer';
import { retrySessionOwnerControlClientDiscovery, stopLocalSessionTree } from './session-stop-tree-local';
import { SessionOwnerControlClientError } from './session-owner-control-client';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];
const SESSION_ID = 'session_expired_owner_recovery';
const CHILD_SESSION_ID = 'session_expired_owner_child';

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local session stop', () => {
    it('settles a running session whose owner lease has expired', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-stale-owner-stop-'));
        directories.push(dataDir);
        const opened = await openCanonicalRuntimeDb({ dataDir, sessionControlMaintenance: false });
        const store = await openLocalSessionEventStore({ dataDir, sessionId: SESSION_ID });
        await appendRunningSession(store, SESSION_ID, 'run_expired_owner');
        await acquireSessionControlLease({
            runtime: opened.runtime,
            dbIdentity: opened.identity.dbIdentity,
            sessionId: SESSION_ID,
            ownerId: 'expired-owner',
            nonceHash: createHash('sha256').update('expired-owner').digest('hex'),
            pid: process.pid,
            processStartId: 'expired-owner-process',
            nowWallMs: 0,
        });
        store.close();
        opened.runtime.close();

        // When
        const result = await stopLocalSessionTree({
            targetSessionId: SESSION_ID,
            scope: 'only',
            requestId: 'request_expired_owner',
            operationId: 'operation_expired_owner',
            timeoutMs: 1_000,
            dataDir,
        });

        // Then
        const reopened = await openCanonicalRuntimeDb({ dataDir, sessionControlMaintenance: false });
        const session = await reopened.runtime.client.execute({
            sql: 'SELECT status FROM sessions WHERE session_id = ?',
            args: [SESSION_ID],
        });
        const events = await reopened.runtime.client.execute({
            sql: 'SELECT type FROM session_events WHERE session_id = ? ORDER BY seq',
            args: [SESSION_ID],
        });
        reopened.runtime.close();
        const replayStore = await openLocalSessionEventStore({ dataDir, sessionId: SESSION_ID });
        const replay = await replayStore.getReplay(SESSION_ID);
        replayStore.close();
        expect(events.rows).toContainEqual({ type: 'run.interrupted' });
        expect(events.rows).toContainEqual({ type: 'session.abort.completed' });
        expect(replay.events.find((event) => event.type === 'run.interrupted')).toMatchObject({
            run: { state: 'interrupted', runId: 'run_expired_owner', reason: 'operator_aborted' },
        });
        expect(replay.snapshot.status).toBe('idle');
        expect(session.rows[0]).toEqual({ status: 'idle' });
        expect(result.errorCode).toBeUndefined();
        expect(result.sessions[0]?.affected.runs).toBe(1);
        expect(result.sessions[0]?.errorCode).toBeUndefined();
        expect(result).toMatchObject({ outcome: 'full', sessions: [{ sessionId: SESSION_ID, outcome: 'interrupted' }] });
    });

    it('holds an expired target barrier for child-only no-op stops', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-stale-owner-stop-'));
        directories.push(dataDir);
        const opened = await openCanonicalRuntimeDb({ dataDir, sessionControlMaintenance: false });
        const store = await openLocalSessionEventStore({ dataDir, sessionId: SESSION_ID });
        await store.append({ type: 'session.started', timestamp: '2026-07-17T00:00:00.000Z', sessionId: SESSION_ID });
        await acquireExpiredLease(opened, SESSION_ID);
        store.close();
        opened.runtime.close();

        // When
        const result = await stopLocalSessionTree({
            targetSessionId: SESSION_ID,
            scope: 'children',
            requestId: 'request_expired_owner_children',
            operationId: 'operation_expired_owner_children',
            timeoutMs: 1_000,
            dataDir,
        });

        // Then
        expect(result).toMatchObject({ outcome: 'no_op', sessions: [] });
        expect(result.errorCode).toBeUndefined();
    });

    it.each([
        { liveSessionId: SESSION_ID, expiredSessionId: CHILD_SESSION_ID, label: 'a live parent and expired child' },
        { liveSessionId: CHILD_SESSION_ID, expiredSessionId: SESSION_ID, label: 'an expired parent and live child' },
    ])('stops a tree with $label', async ({ liveSessionId, expiredSessionId }) => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-stale-owner-stop-'));
        directories.push(dataDir);
        const opened = await openCanonicalRuntimeDb({ dataDir, sessionControlMaintenance: false });
        const rootStore = await openLocalSessionEventStore({ dataDir, sessionId: SESSION_ID });
        const childStore = await openLocalSessionEventStore({ dataDir, sessionId: CHILD_SESSION_ID });
        await appendRunningSession(rootStore, SESSION_ID, 'run_root');
        await appendRunningSession(childStore, CHILD_SESSION_ID, 'run_child');
        await opened.runtime.client.execute({
            sql: 'UPDATE sessions SET parent_session_id = ? WHERE session_id = ?',
            args: [SESSION_ID, CHILD_SESSION_ID],
        });
        rootStore.close();
        childStore.close();
        const liveHost = new SessionControlHost({
            runtime: opened.runtime,
            dbIdentity: opened.identity.dbIdentity,
            dataDir,
        });
        const liveAbort = vi.fn();
        const liveRunId = liveSessionId === SESSION_ID ? 'run_root' : 'run_child';
        await liveHost.acquire(liveSessionId);
        await liveHost.attachEntity({
            sessionId: liveSessionId,
            kind: 'run',
            entityId: liveRunId,
            handles: [
                {
                    kind: 'provider',
                    handleId: `provider:${liveSessionId}`,
                    abort: liveAbort,
                    writeSettlement: async (client, context) => {
                        if (context.kind !== 'operator_stop') return;
                        await appendFencedSessionStopEvent({
                            client,
                            sessionId: liveSessionId,
                            event: {
                                type: 'run.interrupted',
                                timestamp: context.timestamp,
                                sessionId: liveSessionId,
                                run: {
                                    state: 'interrupted',
                                    runId: liveRunId,
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
        await acquireExpiredLease(opened, expiredSessionId);

        // When
        const result = await stopLocalSessionTree({
            targetSessionId: SESSION_ID,
            scope: 'tree',
            requestId: 'request_mixed_ownership',
            operationId: 'operation_mixed_ownership',
            timeoutMs: 1_000,
            dataDir,
        });

        // Then
        expect(result).toMatchObject({
            outcome: 'full',
            sessions: [
                { sessionId: CHILD_SESSION_ID, outcome: 'interrupted' },
                { sessionId: SESSION_ID, outcome: 'interrupted' },
            ],
        });
        expect(liveAbort).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'operator_stop' }));
        await liveHost.close();
        opened.runtime.close();
    });

    it('retries owner discovery while the winning publisher exposes its registry', async () => {
        // Given
        let now = 0;
        let attempts = 0;
        const winner = { ownerId: 'winner' };

        // When
        const result = await retrySessionOwnerControlClientDiscovery({
            createClient: async () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new SessionOwnerControlClientError('owner_unreachable', 'registry is not published yet');
                }
                return winner;
            },
            deadlineMs: 21,
            now: () => now,
            wait: async (delayMs) => {
                now += delayMs;
            },
        });

        // Then
        expect(result).toBe(winner);
        expect(attempts).toBe(3);
    });
});

async function appendRunningSession(
    store: Awaited<ReturnType<typeof openLocalSessionEventStore>>,
    sessionId: string,
    runId: string,
): Promise<void> {
    await store.append({ type: 'session.started', timestamp: '2026-07-17T00:00:00.000Z', sessionId });
    await store.append({
        type: 'run.started',
        timestamp: '2026-07-17T00:00:01.000Z',
        sessionId,
        run: { command: 'run', state: 'running', runId },
    });
}

function acquireExpiredLease(
    opened: Awaited<ReturnType<typeof openCanonicalRuntimeDb>>,
    sessionId: string,
): Promise<unknown> {
    return acquireSessionControlLease({
        runtime: opened.runtime,
        dbIdentity: opened.identity.dbIdentity,
        sessionId,
        ownerId: `expired-owner-${sessionId}`,
        nonceHash: createHash('sha256').update(`expired-owner-${sessionId}`).digest('hex'),
        pid: process.pid,
        processStartId: `expired-owner-process-${sessionId}`,
        nowWallMs: 0,
    });
}
