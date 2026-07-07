import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { localSessionDbPath } from '../memory/local-session-store-paths.js';
import { openSqliteSessionProjectionStore } from '../memory/sqlite-session-projection.js';
import { localRuntimeDbUrl } from './local-runtime-db.js';
import {
    SessionInputDelivery,
    SqlSessionInputDelivery,
    type SqlSessionInputDeliveryRecord,
} from './session-input-delivery.js';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-session-input-delivery-'));
    tempRoots.push(root);
    return root;
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SessionInputDelivery', () => {
    it('characterizes in-memory FIFO steer and queue promotion', () => {
        // Given
        const delivery = new SessionInputDelivery();

        // When
        delivery.admitInput('session_a', { inputId: 'steer_1', prompt: 'first steer' }, 'steer');
        delivery.admitInput('session_a', { inputId: 'queue_1', prompt: 'first queued' }, 'queue');
        delivery.admitInput('session_a', { inputId: 'queue_2', prompt: 'second queued' }, 'queue');

        // Then
        expect(delivery.pendingSteerCount('session_a')).toBe(1);
        expect(delivery.promoteSteers('session_a').map((record) => record.inputId)).toEqual(['steer_1']);
        expect(delivery.promoteNextQueued('session_a')?.inputId).toBe('queue_1');
        expect(delivery.promoteNextQueued('session_a')?.inputId).toBe('queue_2');
        expect(delivery.promoteNextQueued('session_a')).toBeUndefined();
    });
});

describe('SqlSessionInputDelivery', () => {
    it('persists admitted and promoted queued input across reopen', async () => {
        // Given
        const root = await makeTempRoot();
        const first = await SqlSessionInputDelivery.open(root);
        await first.admitInput('session_a', { inputId: 'queue_1', prompt: 'first queued' }, 'queue');
        await first.admitInput('session_a', { inputId: 'queue_2', prompt: 'second queued' }, 'queue');
        await first.promoteNextQueued('session_a');
        first.close();

        // When
        const reopened = await SqlSessionInputDelivery.open(root);
        const pendingBeforePromotion = await reopened.pendingQueuedCount('session_a');
        const promoted = await reopened.promoteNextQueued('session_a');
        const rows = await reopened.listInputs('session_a');
        reopened.close();

        // Then
        expect(pendingBeforePromotion).toBe(1);
        expect(promoted?.inputId).toBe('queue_2');
        expect(projectInputStatuses(rows)).toEqual([
            ['queue_1', 'promoted'],
            ['queue_2', 'promoted'],
        ]);
        expect(existsSync(localSessionDbPath(root))).toBe(true);
        expect(existsSync(join(root, '.omo', 'mission-control.db'))).toBe(false);
    });

    it('derives awaiting user_input from a pending blocking input wait after reopen', async () => {
        // Given
        const root = await makeTempRoot();
        const first = await SqlSessionInputDelivery.open(root);
        await first.admitInput('session_blocked', { inputId: 'approval_prompt', prompt: 'Approve plan?' }, 'queue', {
            blocking: true,
        });
        first.close();

        // When
        const reopened = await SqlSessionInputDelivery.open(root);
        const lifecycle = await reopened.deriveLifecycle('session_blocked');
        reopened.close();

        // Then
        expect(lifecycle).toEqual({
            status: 'awaiting',
            awaitingReason: 'user_input',
            displayReason: 'awaiting user input',
            primaryWaitId: 'input_wait_approval_prompt',
        });
    });

    it('persists awaiting user_input into the public session status row', async () => {
        // Given
        const root = await makeTempRoot();
        const delivery = await SqlSessionInputDelivery.open(root);

        // When
        await delivery.admitInput('session_public_wait', { inputId: 'operator_prompt', prompt: 'Approve?' }, 'queue', {
            blocking: true,
        });
        delivery.close();
        const publicStore = await openSqliteSessionProjectionStore({ url: localRuntimeDbUrl(root) });
        const waitingSession = await publicStore.getSession('session_public_wait');

        const resumedDelivery = await SqlSessionInputDelivery.open(root);
        await resumedDelivery.promoteNextQueued('session_public_wait');
        resumedDelivery.close();
        const resumedSession = await publicStore.getSession('session_public_wait');
        publicStore.close();

        // Then
        expect(waitingSession).toMatchObject({
            sessionId: 'session_public_wait',
            status: 'awaiting',
            awaiting: {
                reason: 'user_input',
                source: { inputId: 'operator_prompt' },
            },
        });
        expect(waitingSession?.awaiting?.source.runId).toBeUndefined();
        expect(resumedSession).toMatchObject({
            sessionId: 'session_public_wait',
            status: 'idle',
        });
        expect(resumedSession?.awaiting).toBeUndefined();
    });

    it('recomputes a resumed user_input wait back to running when the session has an active run', async () => {
        // Given
        const root = await makeTempRoot();
        const delivery = await SqlSessionInputDelivery.open(root);
        await delivery.admitInput('session_running_wait', { inputId: 'operator_prompt', prompt: 'Approve?' }, 'queue', {
            blocking: true,
        });
        delivery.close();
        const client = createClient({ url: localRuntimeDbUrl(root) });
        await client.execute({
            sql:
                'INSERT INTO mission_runs (run_id, mission_id, session_id, status, created_at, updated_at, passthrough_json) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [
                'run_active',
                'mission_running',
                'session_running_wait',
                'running',
                '2026-07-06T00:00:00.000Z',
                '2026-07-06T00:00:00.000Z',
                '{}',
            ],
        });
        client.close();

        // When
        const resumedDelivery = await SqlSessionInputDelivery.open(root);
        await resumedDelivery.promoteNextQueued('session_running_wait');
        const lifecycle = await resumedDelivery.deriveLifecycle('session_running_wait');
        resumedDelivery.close();
        const publicStore = await openSqliteSessionProjectionStore({ url: localRuntimeDbUrl(root) });
        const resumedSession = await publicStore.getSession('session_running_wait');
        publicStore.close();

        // Then
        expect(resumedSession).toMatchObject({
            sessionId: 'session_running_wait',
            status: 'running',
        });
        expect(lifecycle).toEqual({ status: 'running' });
        expect(resumedSession?.awaiting).toBeUndefined();
    });

    it('preserves terminal session status when the final user_input wait resolves', async () => {
        // Given
        const root = await makeTempRoot();
        const delivery = await SqlSessionInputDelivery.open(root);
        await delivery.admitInput('session_stopped_wait', { inputId: 'operator_prompt', prompt: 'Approve?' }, 'queue', {
            blocking: true,
        });
        delivery.close();
        const client = createClient({ url: localRuntimeDbUrl(root) });
        await client.execute({
            sql: 'UPDATE sessions SET stopped_at = ? WHERE session_id = ?',
            args: ['2026-07-06T00:01:00.000Z', 'session_stopped_wait'],
        });
        client.close();

        // When
        const resumedDelivery = await SqlSessionInputDelivery.open(root);
        await resumedDelivery.promoteNextQueued('session_stopped_wait');
        resumedDelivery.close();
        const publicStore = await openSqliteSessionProjectionStore({ url: localRuntimeDbUrl(root) });
        const resumedSession = await publicStore.getSession('session_stopped_wait');
        publicStore.close();

        // Then
        expect(resumedSession).toMatchObject({
            sessionId: 'session_stopped_wait',
            status: 'stopped',
        });
        expect(resumedSession?.awaiting).toBeUndefined();
    });

    it('rejects duplicate input ids without corrupting pending input state', async () => {
        // Given
        const root = await makeTempRoot();
        const delivery = await SqlSessionInputDelivery.open(root);
        await delivery.admitInput('session_a', { inputId: 'same_input', prompt: 'one' }, 'queue');

        await expect(
            delivery.admitInput('session_a', { inputId: 'same_input', prompt: 'two' }, 'queue'),
        ).rejects.toThrow();
        expect(await delivery.pendingQueuedCount('session_a')).toBe(1);
        delivery.close();
    });
});

function projectInputStatuses(rows: readonly SqlSessionInputDeliveryRecord[]): readonly (readonly [string, string])[] {
    return rows.map((row) => [row.inputId, row.status]);
}
