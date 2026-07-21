import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { projectSessionEventsToSqlite, type SqliteSessionProjectionStore } from './sqlite-session-projection';
import {
    CREATED_AT,
    cleanupSqliteSessionProjectionTestDirs,
    completeProjectionEvents,
    openSqliteSessionProjectionStoreForTests,
    SESSION_ID,
    tempDbUrl,
} from './sqlite-session-projection-test-support';

describe('sqlite session projection', () => {
    afterEach(async () => {
        await cleanupSqliteSessionProjectionTestDirs();
    });

    it('persists SQLite projection records across reopen', async () => {
        // Given: a SQLite session projection store receives a durable event stream.
        const url = await tempDbUrl('reopen');
        const store = await openSqliteSessionProjectionStoreForTests(url);

        // When: events are projected, the DB is closed, and the store is reopened.
        await projectSessionEventsToSqlite({
            store,
            sessionId: SESSION_ID,
            sourcePath: 'sessions/session_sqlite_projection_test.jsonl',
            envelopes: completeProjectionEvents(SESSION_ID),
        });
        store.close();
        const reopened = await openSqliteSessionProjectionStoreForTests(url);

        // Then: callers see direct projection query semantics without replaying JSONL.
        await expectQueryCoverage(reopened, SESSION_ID);
        reopened.close();
    });

    it('writes sessions, messages, tools, approvals, and provider failures rows from events', async () => {
        // Given: a projected session with assistant messages, a tool call, approval, and provider failure.
        const url = await tempDbUrl('projection-rows');
        const store = await openSqliteSessionProjectionStoreForTests(url);

        // When: the post-append projection path runs.
        await projectSessionEventsToSqlite({
            store,
            sessionId: SESSION_ID,
            sourcePath: 'sessions/session_sqlite_projection_test.jsonl',
            envelopes: completeProjectionEvents(SESSION_ID),
        });
        store.close();

        // Then: list/status views and detail panes have direct projection rows.
        const client = createClient({ url });
        const sessions = await client.execute(
            'SELECT session_id, status, last_event_seq, metadata_json FROM sessions ORDER BY session_id',
        );
        const messages = await client.execute(
            'SELECT message_id, role FROM session_messages WHERE session_id = ? ORDER BY seq',
            [SESSION_ID],
        );
        const parts = await client.execute(
            'SELECT kind, text FROM session_parts WHERE session_id = ? ORDER BY part_index',
            [SESSION_ID],
        );
        const tools = await client.execute(
            'SELECT tool_call_id, name, status FROM tool_calls WHERE session_id = ? ORDER BY tool_call_id',
            [SESSION_ID],
        );
        const approvals = await client.execute(
            'SELECT approval_id, status, subject_kind, subject_id FROM approvals WHERE session_id = ?',
            [SESSION_ID],
        );
        const failures = await client.execute(
            'SELECT event_id, request_id FROM provider_failures WHERE session_id = ?',
            [SESSION_ID],
        );
        client.close();

        expect(sessions.rows).toEqual([
            {
                session_id: SESSION_ID,
                status: 'stopped',
                last_event_seq: 10,
                metadata_json: JSON.stringify({
                    eventCount: 10,
                    lastEventId: 'event_session_stopped',
                    lastEventType: 'session.stopped',
                }),
            },
        ]);
        expect(messages.rows).toEqual([{ message_id: 'message_task_prompt_1', role: 'assistant' }]);
        expect(parts.rows).toEqual([{ kind: 'text', text: 'assistant summary' }]);
        expect(tools.rows).toEqual([{ tool_call_id: 'patch_call', name: 'file.patch', status: 'failed' }]);
        expect(approvals.rows).toEqual([
            {
                approval_id: 'approval_patch',
                status: 'approved',
                subject_kind: 'tool',
                subject_id: 'file.patch',
            },
        ]);
        expect(failures.rows).toEqual([
            {
                event_id: 'event_provider_failed',
                request_id: 'provider_request_task_prompt_1',
            },
        ]);
    });

    it('updates session projections without deleting append-only session rows', async () => {
        // Given: an append-only event ledger row exists and deletes from sessions are forbidden.
        const url = await tempDbUrl('append-only-safe');
        const store = await openSqliteSessionProjectionStoreForTests(url);
        const client = createClient({ url });
        await client.execute({
            sql: `
                INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at)
                VALUES (?, 'running', ?, ?, ?)
            `,
            args: [SESSION_ID, CREATED_AT, CREATED_AT, CREATED_AT],
        });
        await client.execute({
            sql: `
                INSERT INTO session_events (session_id, seq, event_id, type, timestamp, payload_json)
                VALUES (?, 0, 'event_session_started', 'session.started', ?, '{}')
            `,
            args: [SESSION_ID, CREATED_AT],
        });
        await client.execute(`
            CREATE TRIGGER sessions_delete_is_not_projection_safe
            BEFORE DELETE ON sessions
            BEGIN
                SELECT RAISE(ABORT, 'projection must not delete sessions');
            END
        `);

        // When: the projection is replaced for the same session.
        await projectSessionEventsToSqlite({
            store,
            sessionId: SESSION_ID,
            sourcePath: 'sessions/session_sqlite_projection_test.jsonl',
            envelopes: completeProjectionEvents(SESSION_ID),
        });
        const eventRows = await client.execute({
            sql: 'SELECT event_id FROM session_events WHERE session_id = ? ORDER BY seq',
            args: [SESSION_ID],
        });
        const sessions = await client.execute({
            sql: 'SELECT status, last_event_seq FROM sessions WHERE session_id = ?',
            args: [SESSION_ID],
        });
        client.close();
        store.close();

        // Then: the summary row was updated in place and the append-only ledger survived.
        expect(eventRows.rows).toEqual([{ event_id: 'event_session_started' }]);
        expect(sessions.rows).toEqual([{ status: 'stopped', last_event_seq: 10 }]);
    });

    it('allows two sessions to reuse the same tool_call_id without colliding', async () => {
        // Given: the tool_calls primary key is session-scoped, so cross-session tool_call_id
        // reuse (deterministic fixtures, provider id reuse) must not raise SQLITE_CONSTRAINT.
        const url = await tempDbUrl('cross-session-tool-call-id');
        const store = await openSqliteSessionProjectionStoreForTests(url);
        const client = createClient({ url });
        const otherSessionId = 'session_other_reuses_tool_id';
        for (const sessionId of [SESSION_ID, otherSessionId]) {
            await client.execute({
                sql: `INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at)
                      VALUES (?, 'running', ?, ?, ?)`,
                args: [sessionId, CREATED_AT, CREATED_AT, CREATED_AT],
            });
            await client.execute({
                sql: `INSERT INTO tool_calls (tool_call_id, session_id, name, status)
                      VALUES ('shared_tool_call', ?, 'read', 'completed')`,
                args: [sessionId],
            });
        }
        const rows = await client.execute({
            sql: `SELECT session_id, tool_call_id, status FROM tool_calls ORDER BY session_id, tool_call_id`,
        });
        client.close();
        store.close();

        expect(rows.rows).toEqual([
            { session_id: otherSessionId, tool_call_id: 'shared_tool_call', status: 'completed' },
            { session_id: SESSION_ID, tool_call_id: 'shared_tool_call', status: 'completed' },
        ]);
    });
});

async function expectQueryCoverage(store: SqliteSessionProjectionStore, sessionId: string): Promise<void> {
    await expect(store.getSession(sessionId)).resolves.toMatchObject({
        sessionId,
        status: 'stopped',
        eventCount: 10,
        lastEventId: 'event_session_stopped',
    });
    await expect(store.listSessions()).resolves.toHaveLength(1);
    await expect(store.getRuns(sessionId)).resolves.toEqual([
        expect.objectContaining({
            runId: 'run_1',
            state: 'running',
            eventType: 'run.started',
        }),
    ]);
    await expect(store.getApprovals(sessionId)).resolves.toEqual([
        expect.objectContaining({
            approvalId: 'approval_patch',
            state: 'approved',
        }),
    ]);
    await expect(store.getTools(sessionId)).resolves.toEqual([
        expect.objectContaining({
            toolId: 'patch_call',
            status: 'failed',
            lastMessage: 'tool failed: file.patch',
            appliedFiles: ['a.txt'],
        }),
    ]);
    await expect(store.getProviderFailures(sessionId)).resolves.toEqual([
        expect.objectContaining({
            requestId: 'provider_request_task_prompt_1',
            error: expect.objectContaining({ code: 'unknown' }),
        }),
    ]);
}
