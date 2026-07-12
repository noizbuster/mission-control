import { createClient } from '@libsql/client';
import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { projectSessionAdmission } from '../session-admission.js';
import {
    abortCompleted,
    abortedSessionEvents,
    approvalWaitWithCancelledInputEvents,
    auditEvent,
    nextRunStarted,
    SESSION_ID,
    sessionStarted,
} from './session-stop-projection-events-test-support.js';
import {
    insertSurvivor,
    openStore,
    readProjectionRows,
    readSessionRow,
    sessionStatus,
    settleSurvivor,
} from './session-stop-projection-test-support.js';
import {
    cleanupSqliteSessionEventStoreTestDirs,
    createSqliteSessionEventStoreTestDbUrl,
} from './sqlite-session-event-store-test-support.js';
import { projectSessionEventsToSqlite } from './sqlite-session-projection.js';
import { openSqliteSessionProjectionStoreForTests } from './sqlite-session-projection-test-support.js';

describe('session stop SQLite projection', () => {
    afterEach(cleanupSqliteSessionEventStoreTestDirs);

    it('reopens cancelled input, wait, approval, and abort marker as idle(aborted)', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('abort-reopen');
        const store = await openStore(url);
        for (const event of abortedSessionEvents()) await store.append(event);
        await store.close();

        const reopened = await openStore(url);
        const events = await reopened.getEvents(SESSION_ID);
        const admission = projectSessionAdmission(events, SESSION_ID);
        await reopened.close();
        const rows = await readProjectionRows(url);

        expect(admission.pendingInputs).toEqual([]);
        expect(events.filter((event) => event.type === 'prompt.promoted')).toEqual([]);
        expect(events.filter((event) => event.type === 'run.interrupted')).toHaveLength(1);
        expect(rows.session).toMatchObject({ status: 'idle' });
        expect(JSON.parse(String(rows.session?.metadata_json))).toMatchObject({ lifecycleReason: 'aborted' });
        expect(rows.inputs).toEqual([{ input_id: 'input_cancelled', status: 'cancelled' }]);
        expect(rows.approvals).toEqual([{ approval_id: 'approval_stop', status: 'cancelled' }]);
        expect(rows.waits).toEqual([
            { wait_id: 'approval_stop', reason: 'approval', status: 'cancelled' },
            { wait_id: 'input_wait_input_cancelled', reason: 'user_input', status: 'cancelled' },
        ]);
        expect(rows.failureCodes).toEqual(['unknown']);
        expect(rows.auditTypes).toContain('model.call.failed:provider_aborted');
        expect(rows.auditTypes).toContain('log');
        expect(rows.auditTypes).toContain('session.abort.completed');
    });

    it('projects marker-only no-run cleanup without a synthetic interruption', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('marker-only');
        const store = await openStore(url);
        await store.append(abortCompleted(0));
        await store.close();

        const rows = await readProjectionRows(url);
        expect(rows.session).toMatchObject({ status: 'idle' });
        expect(rows.eventTypes).toEqual(['session.abort.completed']);
        expect(JSON.parse(String(rows.session?.metadata_json))).toMatchObject({ lifecycleReason: 'aborted' });

        const resumed = await openStore(url);
        await resumed.append(nextRunStarted());
        await resumed.close();
        const resumedRows = await readProjectionRows(url);
        expect(resumedRows.session.status).toBe('running');
        expect(JSON.parse(resumedRows.session.metadata_json)).not.toHaveProperty('lifecycleReason');
    });

    it.each(['mission', 'job'] as const)('waits for a nonterminal %s authority before idle(aborted)', async (kind) => {
        const url = await createSqliteSessionEventStoreTestDbUrl(`survivor-${kind}`);
        const store = await openStore(url);
        await store.append(sessionStarted());
        const client = createClient({ url });
        await insertSurvivor(client, kind);
        await store.append(abortCompleted(0));
        expect(await sessionStatus(client)).toBe('running');

        await settleSurvivor(client, kind);
        await store.append(auditEvent());
        expect(await sessionStatus(client)).toBe('idle');
        const row = await readSessionRow(client);
        expect(JSON.parse(row.metadata_json)).toMatchObject({ lifecycleReason: 'aborted' });
        client.close();
        await store.close();
    });

    it('rebuilds idle(aborted) without claiming mission or job state came from replay', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('projection-rebuild');
        const store = await openSqliteSessionProjectionStoreForTests(url);
        const marker = abortCompleted(0);
        const markerEnvelope = AgentEventEnvelopeSchema.parse({
            eventId: 'event_marker',
            sequence: 0,
            createdAt: marker.timestamp,
            sessionId: SESSION_ID,
            durability: 'durable',
            event: marker,
        });
        await projectSessionEventsToSqlite({
            store,
            sessionId: SESSION_ID,
            sourcePath: 'manual-rebuild',
            envelopes: [markerEnvelope],
        });
        await expect(store.getSession(SESSION_ID)).resolves.toMatchObject({ status: 'idle' });

        const nextRun = nextRunStarted();
        const runEnvelope = AgentEventEnvelopeSchema.parse({
            eventId: 'event_next_run',
            sequence: 1,
            createdAt: nextRun.timestamp,
            sessionId: SESSION_ID,
            durability: 'durable',
            event: nextRun,
        });
        await projectSessionEventsToSqlite({
            store,
            sessionId: SESSION_ID,
            sourcePath: 'manual-rebuild',
            envelopes: [markerEnvelope, runEnvelope],
        });
        await expect(store.getSession(SESSION_ID)).resolves.toMatchObject({ status: 'running' });
        store.close();
    });

    it('keeps an unrelated approval wait pending when only the queued input is cancelled', async () => {
        const url = await createSqliteSessionEventStoreTestDbUrl('input-cancel-during-approval');
        const store = await openStore(url);
        for (const event of approvalWaitWithCancelledInputEvents()) await store.append(event);
        await store.close();

        const rows = await readProjectionRows(url);
        expect(rows.session.status).toBe('awaiting');
        expect(rows.waits).toEqual([
            { wait_id: 'approval_stop', reason: 'approval', status: 'pending' },
            { wait_id: 'input_wait_input_cancelled', reason: 'user_input', status: 'cancelled' },
        ]);
        const reopened = await openStore(url);
        await expect(reopened.getReplay(SESSION_ID)).resolves.toMatchObject({ snapshot: { status: 'awaiting' } });
        await reopened.close();
    });
});
