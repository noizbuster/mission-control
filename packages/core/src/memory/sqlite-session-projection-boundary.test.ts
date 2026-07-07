import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { envelope } from '../session-replay-coding-test-support.js';
import { refreshSessionAwaitingFromPendingWaits } from './session-awaiting-sql.js';
import { openSqliteSessionProjectionStore, projectSessionEventsToSqlite } from './sqlite-session-projection.js';
import {
    CREATED_AT,
    cleanupSqliteSessionProjectionTestDirs,
    completeProjectionEvents,
    SESSION_ID,
    sessionStartedEvent,
    tempDbUrl,
} from './sqlite-session-projection-test-support.js';

describe('sqlite session projection boundary cases', () => {
    afterEach(async () => {
        await cleanupSqliteSessionProjectionTestDirs();
    });

    it('round trips awaiting reason and source through public session projection reads', async () => {
        // Given: a SQLite-native session summary with approval wait metadata.
        const url = await tempDbUrl('awaiting');
        const store = await openSqliteSessionProjectionStore({ url });

        // When: the public projection store writes and reads the awaiting summary.
        await store.replaceSessionProjection({
            sessionId: SESSION_ID,
            records: [
                {
                    kind: 'session',
                    sessionId: SESSION_ID,
                    status: 'awaiting',
                    awaiting: {
                        reason: 'approval',
                        source: {
                            approvalId: 'approval_patch',
                            runId: 'run_1',
                            toolCallId: 'patch_call',
                        },
                    },
                    startedAt: CREATED_AT,
                    eventCount: 4,
                    lastSequence: 4,
                    updatedAt: '2026-06-05T10:04:00.000Z',
                    sourcePath: 'sessions/session_sqlite_projection_test.jsonl',
                },
            ],
            diagnostics: [],
            envelopes: [],
        });
        const session = await store.getSession(SESSION_ID);
        const client = createClient({ url });
        const sessions = await client.execute(
            'SELECT status, awaiting_reason, primary_wait_id FROM sessions WHERE session_id = ?',
            [SESSION_ID],
        );
        const waits = await client.execute(
            'SELECT reason, source_kind, source_id, approval_id, run_id, tool_call_id FROM session_awaits WHERE session_id = ?',
            [SESSION_ID],
        );
        client.close();
        store.close();

        // Then: compact status columns and full source metadata are both queryable.
        expect(session).toMatchObject({
            status: 'awaiting',
            awaiting: {
                reason: 'approval',
                source: {
                    approvalId: 'approval_patch',
                    runId: 'run_1',
                    toolCallId: 'patch_call',
                },
            },
        });
        expect(sessions.rows).toEqual([
            {
                status: 'awaiting',
                awaiting_reason: 'approval',
                primary_wait_id: 'approval_patch',
            },
        ]);
        expect(waits.rows).toEqual([
            {
                reason: 'approval',
                source_kind: 'approval',
                source_id: 'approval_patch',
                approval_id: 'approval_patch',
                run_id: 'run_1',
                tool_call_id: 'patch_call',
            },
        ]);
    });

    it('clears stale pending awaits when an authoritative projection replacement is no longer awaiting', async () => {
        // Given: a projected session is currently awaiting approval.
        const url = await tempDbUrl('awaiting-replacement');
        const store = await openSqliteSessionProjectionStore({ url });
        await store.replaceSessionProjection({
            sessionId: SESSION_ID,
            records: [
                {
                    kind: 'session',
                    sessionId: SESSION_ID,
                    status: 'awaiting',
                    awaiting: {
                        reason: 'approval',
                        source: {
                            approvalId: 'approval_patch',
                            runId: 'run_1',
                            toolCallId: 'patch_call',
                        },
                    },
                    startedAt: CREATED_AT,
                    eventCount: 4,
                    lastSequence: 4,
                    updatedAt: '2026-06-05T10:04:00.000Z',
                    sourcePath: 'sessions/session_sqlite_projection_test.jsonl',
                },
            ],
            diagnostics: [],
            envelopes: [],
        });

        // When: a later complete projection replaces that snapshot after the approval is approved and stopped.
        await projectSessionEventsToSqlite({
            store,
            sessionId: SESSION_ID,
            sourcePath: 'sessions/session_sqlite_projection_test.jsonl',
            envelopes: completeProjectionEvents(SESSION_ID),
        });
        const client = createClient({ url });
        const waitsAfterReplacement = await client.execute(
            'SELECT wait_id, reason, status FROM session_awaits WHERE session_id = ? ORDER BY wait_id',
            [SESSION_ID],
        );
        await refreshSessionAwaitingFromPendingWaits({
            client,
            sessionId: SESSION_ID,
            now: '2026-06-05T10:10:00.000Z',
        });
        const waitsAfterRefresh = await client.execute(
            'SELECT wait_id, reason, status FROM session_awaits WHERE session_id = ? ORDER BY wait_id',
            [SESSION_ID],
        );
        const sessionAfterRefresh = await store.getSession(SESSION_ID);
        client.close();
        store.close();

        // Then: the active-waits table follows the replacement snapshot and refresh cannot resurrect stale awaiting.
        expect(waitsAfterReplacement.rows).toEqual([]);
        expect(waitsAfterRefresh.rows).toEqual([]);
        expect(sessionAfterRefresh).toMatchObject({
            sessionId: SESSION_ID,
            status: 'stopped',
        });
        expect(sessionAfterRefresh?.awaiting).toBeUndefined();
    });

    it('fails closed with a diagnostic for malformed event payloads', async () => {
        // Given: a stale projection already exists for a session.
        const url = await tempDbUrl('malformed');
        const store = await openSqliteSessionProjectionStore({ url });
        await projectSessionEventsToSqlite({
            store,
            sessionId: SESSION_ID,
            sourcePath: 'sessions/session_sqlite_projection_test.jsonl',
            envelopes: [envelope(sessionStartedEvent(SESSION_ID), 1, 'event_session_started')],
        });

        // When: malformed event input reaches the projection boundary.
        await projectSessionEventsToSqlite({
            store,
            sessionId: SESSION_ID,
            sourcePath: 'sessions/session_sqlite_projection_test.jsonl',
            envelopes: [{ malformed: true }],
        });

        // Then: append-only session rows are preserved and a diagnostic is queryable.
        await expect(store.getSession(SESSION_ID)).resolves.toMatchObject({
            sessionId: SESSION_ID,
            eventCount: 1,
        });
        await expect(store.getDiagnostics(SESSION_ID)).resolves.toEqual([
            expect.objectContaining({
                kind: 'corrupt_jsonl',
                sessionId: SESSION_ID,
                code: 'unknown',
            }),
        ]);
        store.close();
    });
});
