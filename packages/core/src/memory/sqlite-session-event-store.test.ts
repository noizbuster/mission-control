import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlAgentJobMirror } from '../agents/agent-job-sql-mirror';
import { localRuntimeDbUrl } from '../runtime/local-runtime-db';
import { SqlSessionInputDelivery } from '../runtime/session-input-delivery-sql';
import {
    approvalEvent,
    runEvent,
    sessionStoppedEvent,
    toolCompletedEvent,
} from '../session-replay-coding-test-support';
import { JsonlSessionEventStore } from './jsonl-session-event-store';
import { replayParityEvents, replayParitySummary } from './session-replay-parity-fixtures';
import {
    cleanupSqliteSessionEventStoreTestDirs,
    createSqliteSessionEventStoreTestDbUrl,
    createSqliteSessionEventStoreTestDir,
    detailedProjectionEvents,
    openSqliteSessionEventStoreForTests,
    sessionStartedEvent,
    taskCompletedEvent,
    taskFailedEvent,
} from './sqlite-session-event-store-test-support';
import { openSqliteSessionProjectionStoreForTests } from './sqlite-session-projection-test-support';

afterEach(async () => {
    await cleanupSqliteSessionEventStoreTestDirs();
});

describe('SqliteSessionEventStore', () => {
    it('matches JSONL replay snapshots when appending the parity fixture sequence', async () => {
        // Given: the same session event sequence is written through JSONL and SQLite stores.
        const sessionId = 'session_sqlite_replay_parity';
        const dataDir = await createSqliteSessionEventStoreTestDir('jsonl-data');
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('jsonl-db');
        const jsonl = await JsonlSessionEventStore.open({
            dataDir,
            sessionId,
            now: () => '2026-06-21T10:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const sqlite = await openSqliteSessionEventStoreForTests({
            url: sqliteUrl,
            sessionId,
            now: () => '2026-06-21T10:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: each store receives the fixture events.
            for (const event of replayParityEvents(sessionId)) {
                await jsonl.append(event);
                await sqlite.append(event);
            }

            // Then: ordered events and derived snapshots match JSONL behavior.
            expect(await sqlite.getEvents(sessionId)).toEqual(await jsonl.getEvents(sessionId));
            expect(await sqlite.getSnapshot(sessionId)).toEqual(await jsonl.getSnapshot(sessionId));
            expect(replayParitySummary(await sqlite.getReplay(sessionId))).toMatchObject({
                sequences: replayParityEvents(sessionId).map((_event, sequence) => sequence),
                eventIds: replayParityEvents(sessionId).map((_event, sequence) => `event_${sequence}`),
                snapshot: {
                    status: 'stopped',
                    completedTaskCount: 1,
                    lastMessage: 'stopped parity session',
                },
            });
        } finally {
            await jsonl.close();
            await sqlite.close();
        }
    });

    it('reopens a file database with ordered durable events and snapshot state intact', async () => {
        // Given: a SQLite store has appended two durable events to a file database.
        const sessionId = 'session_sqlite_reopen';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('reopen');
        const first = await openSqliteSessionEventStoreForTests({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const started = sessionStartedEvent(sessionId);
        const completed = taskCompletedEvent(sessionId);
        await first.append(started);
        await first.append(completed);
        await first.close();

        // When: a fresh store instance reopens the same database.
        const reopened = await openSqliteSessionEventStoreForTests({ url: sqliteUrl, sessionId });
        const events = await reopened.getEvents(sessionId);
        const snapshot = await reopened.getSnapshot(sessionId);
        await reopened.close();

        // Then: durable ordering and replay projection survived the reopen.
        expect(events).toEqual([started, completed]);
        expect(snapshot).toMatchObject({
            sessionId,
            completedTaskCount: 1,
            lastMessage: 'completed from sqlite',
        });
    });

    it('projects detailed session rows from production append writes', async () => {
        // Given: the production SQLite event store receives a coding-agent event sequence.
        const sessionId = 'session_sqlite_append_projection';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('projection');
        const store = await openSqliteSessionEventStoreForTests({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: callers append through the production store surface.
            for (const event of detailedProjectionEvents(sessionId)) {
                await store.append(event);
            }
        } finally {
            await store.close();
        }

        // Then: the append-only ledger and direct detail projections are queryable without helper seeding.
        const client = createClient({ url: sqliteUrl });
        const events = await client.execute('SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?', [
            sessionId,
        ]);
        const messages = await client.execute(
            'SELECT message_id, role FROM session_messages WHERE session_id = ? ORDER BY seq',
            [sessionId],
        );
        const tools = await client.execute(
            'SELECT tool_call_id, name, status FROM tool_calls WHERE session_id = ? ORDER BY tool_call_id',
            [sessionId],
        );
        const approvals = await client.execute(
            'SELECT approval_id, status FROM approvals WHERE session_id = ? ORDER BY approval_id',
            [sessionId],
        );
        const failures = await client.execute(
            'SELECT event_id, request_id FROM provider_failures WHERE session_id = ? ORDER BY event_id',
            [sessionId],
        );
        client.close();

        expect(events.rows).toEqual([{ count: 10 }]);
        expect(messages.rows).toEqual([{ message_id: 'message_task_prompt_1', role: 'assistant' }]);
        expect(tools.rows).toEqual([{ tool_call_id: 'patch_call', name: 'file.patch', status: 'failed' }]);
        expect(approvals.rows).toEqual([{ approval_id: 'approval_patch', status: 'approved' }]);
        expect(failures.rows).toEqual([{ event_id: 'event_8', request_id: 'provider_request_task_prompt_1' }]);
    });

    it('preserves runtime-owned user_input waits when appending a normal event', async () => {
        // Given: input delivery owns a blocking operator wait before the session event store appends.
        const sessionId = 'session_append_user_input_wait';
        const root = await createSqliteSessionEventStoreTestDir('runtime-user-input');
        const sqliteUrl = localRuntimeDbUrl(root);
        const delivery = await SqlSessionInputDelivery.open({ dataDir: root });
        await delivery.admitInput(sessionId, { inputId: 'operator_prompt', prompt: 'Approve?' }, 'queue', {
            blocking: true,
        });
        delivery.close();
        const store = await openSqliteSessionEventStoreForTests({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: a normal append rebuilds the projection for the same session.
            await store.append(sessionStartedEvent(sessionId));
        } finally {
            await store.close();
        }

        const publicStore = await openSqliteSessionProjectionStoreForTests(sqliteUrl);
        const client = createClient({ url: sqliteUrl });
        const waits = await client.execute(
            'SELECT wait_id, reason, source_kind, source_id, status FROM session_awaits WHERE session_id = ? ORDER BY wait_id',
            [sessionId],
        );
        const publicSession = await publicStore.getSession(sessionId);
        client.close();
        publicStore.close();

        // Then: the runtime wait remains authoritative until input promotion resolves it.
        expect(waits.rows).toEqual([
            {
                wait_id: 'input_wait_operator_prompt',
                reason: 'user_input',
                source_kind: 'operator',
                source_id: 'operator_prompt',
                status: 'pending',
            },
        ]);
        expect(publicSession).toMatchObject({
            sessionId,
            status: 'awaiting',
            awaiting: {
                reason: 'user_input',
                source: { inputId: 'operator_prompt' },
            },
        });
    });

    it('preserves runtime-owned foreground subagent waits when appending a normal event', async () => {
        // Given: the agent-job mirror owns a foreground child wait before a later append.
        const sessionId = 'session_append_subagent_wait';
        const childSessionId = 'child_append_subagent_wait';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('runtime-subagent');
        const client = createClient({ url: sqliteUrl });
        const mirror = await SqlAgentJobMirror.createForTests(client);
        await mirror.startSubagentWait({
            parentSessionId: sessionId,
            childSessionId,
            mode: 'sync',
        });
        await mirror.flush();
        const store = await openSqliteSessionEventStoreForTests({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            // When: a normal append rebuilds the projection for the parent session.
            await store.append(sessionStartedEvent(sessionId));
        } finally {
            await store.close();
        }

        const publicStore = await openSqliteSessionProjectionStoreForTests(sqliteUrl);
        const waits = await client.execute(
            'SELECT wait_id, reason, source_kind, source_id, status FROM session_awaits WHERE session_id = ? ORDER BY wait_id',
            [sessionId],
        );
        const publicSession = await publicStore.getSession(sessionId);
        client.close();
        publicStore.close();

        // Then: the foreground child wait still drives public awaiting/subagent status.
        expect(waits.rows).toEqual([
            {
                wait_id: childSessionId,
                reason: 'subagent',
                source_kind: 'child_session',
                source_id: childSessionId,
                status: 'pending',
            },
        ]);
        expect(publicSession).toMatchObject({
            sessionId,
            status: 'awaiting',
            awaiting: {
                reason: 'subagent',
                source: {
                    jobId: childSessionId,
                    childSessionId,
                },
            },
        });
    });

    it('returns sessions.status to idle after run terminal events', async () => {
        // Given: a durable session that starts a run.
        const sessionId = 'session_status_idle_after_run';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('status-idle');
        const store = await openSqliteSessionEventStoreForTests({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            await store.append(sessionStartedEvent(sessionId));
            await store.append(
                runEvent(sessionId, 'run.started', 'run started', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_1',
                }),
            );

            // When: the run completes normally.
            await store.append(
                runEvent(sessionId, 'run.completed', 'run completed', {
                    command: 'run',
                    state: 'completed',
                    runId: 'run_1',
                }),
            );

            // Then: the session is idle between turns (not stuck running).
            const client = createClient({ url: sqliteUrl });
            const afterCompleted = await client.execute(
                'SELECT status, awaiting_reason, primary_wait_id FROM sessions WHERE session_id = ?',
                [sessionId],
            );
            expect(afterCompleted.rows).toEqual([{ status: 'idle', awaiting_reason: null, primary_wait_id: null }]);

            // When: later terminal run outcomes land on a fresh run.
            await store.append(
                runEvent(sessionId, 'run.started', 'run started again', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_2',
                }),
            );
            await store.append(
                runEvent(sessionId, 'run.failed', 'run failed', {
                    command: 'run',
                    state: 'failed',
                    runId: 'run_2',
                    reason: 'provider exploded',
                }),
            );
            const afterFailed = await client.execute('SELECT status FROM sessions WHERE session_id = ?', [sessionId]);
            expect(afterFailed.rows).toEqual([{ status: 'idle' }]);

            await store.append(
                runEvent(sessionId, 'run.started', 'run started third', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_3',
                }),
            );
            await store.append(
                runEvent(sessionId, 'run.interrupted', 'run interrupted', {
                    command: 'interrupt',
                    state: 'interrupted',
                    runId: 'run_3',
                }),
            );
            const afterInterrupted = await client.execute('SELECT status FROM sessions WHERE session_id = ?', [
                sessionId,
            ]);
            expect(afterInterrupted.rows).toEqual([{ status: 'idle' }]);

            await store.append(
                runEvent(sessionId, 'run.started', 'run started fourth', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_4',
                }),
            );
            await store.append(
                runEvent(sessionId, 'run.failed', 'Failed to create SyntaxStyle', {
                    command: 'run',
                    state: 'failed',
                    runId: 'run_4',
                    reason: 'Failed to create SyntaxStyle',
                }),
            );
            await store.append(taskFailedEvent(sessionId, 'Failed to create SyntaxStyle'));
            const afterTaskFailed = await client.execute('SELECT status FROM sessions WHERE session_id = ?', [
                sessionId,
            ]);
            expect(afterTaskFailed.rows).toEqual([{ status: 'idle' }]);

            // When: a zero-turn drain settles with run.idle.
            await store.append(
                runEvent(sessionId, 'run.started', 'run started fifth', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_5',
                }),
            );
            await store.append(
                runEvent(sessionId, 'run.idle', 'run idle', {
                    command: 'run',
                    state: 'idle',
                    runId: 'run_5',
                }),
            );
            const afterIdle = await client.execute('SELECT status FROM sessions WHERE session_id = ?', [sessionId]);
            expect(afterIdle.rows).toEqual([{ status: 'idle' }]);
            client.close();
        } finally {
            await store.close();
        }
    });

    it('touches sessions.updated_at for throttled ephemeral stream envelopes', async () => {
        const sessionId = 'session_status_ephemeral_activity';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('status-ephemeral');
        const store = await openSqliteSessionEventStoreForTests({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            await store.append(sessionStartedEvent(sessionId));
            await store.append(
                runEvent(sessionId, 'run.started', 'run started', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_stream',
                }),
            );
            const client = createClient({ url: sqliteUrl });
            const before = await client.execute(
                'SELECT updated_at, last_activity_at, status FROM sessions WHERE session_id = ?',
                [sessionId],
            );
            expect(before.rows[0]).toMatchObject({ status: 'running' });
            const beforeUpdatedAt = String(before.rows[0]?.updated_at ?? '');

            await store.appendEnvelope({
                eventId: 'ephemeral_1',
                sequence: 0,
                createdAt: '2026-07-18T12:00:05.000Z',
                sessionId,
                durability: 'ephemeral',
                event: {
                    type: 'task.progress',
                    timestamp: '2026-07-18T12:00:05.000Z',
                    sessionId,
                    message: 'partial',
                    providerStreamChunk: {
                        kind: 'text_delta',
                        requestId: 'req_1',
                        sequence: 1,
                        sourceEventType: 'response.output_text.delta',
                        delta: 'hel',
                    },
                },
            });
            const after = await client.execute(
                'SELECT updated_at, last_activity_at, status FROM sessions WHERE session_id = ?',
                [sessionId],
            );
            expect(after.rows).toEqual([
                {
                    updated_at: '2026-07-18T12:00:05.000Z',
                    last_activity_at: '2026-07-18T12:00:05.000Z',
                    status: 'running',
                },
            ]);
            expect(after.rows[0]?.updated_at).not.toBe(beforeUpdatedAt);
            const eventCount = await client.execute(
                'SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?',
                [sessionId],
            );
            expect(Number(eventCount.rows[0]?.count)).toBe(2);
            client.close();
        } finally {
            await store.close();
        }
    });

    it('keeps mid-run status running and maps blocked/stopped correctly', async () => {
        // Given: a session with an active run that blocks on approval.
        const sessionId = 'session_status_mid_run';
        const sqliteUrl = await createSqliteSessionEventStoreTestDbUrl('status-mid-run');
        const store = await openSqliteSessionEventStoreForTests({
            url: sqliteUrl,
            sessionId,
            createEventId: (_event, sequence) => `event_${sequence}`,
        });

        try {
            await store.append(sessionStartedEvent(sessionId));
            await store.append(
                runEvent(sessionId, 'run.started', 'run started', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_1',
                }),
            );
            await store.append(approvalEvent(sessionId, 'approval.requested', 'pending'));
            await store.append(
                runEvent(sessionId, 'run.blocked', 'waiting for approval: file.patch', {
                    command: 'run',
                    state: 'blocked_on_approval',
                    runId: 'run_1',
                    reason: 'waiting for approval: file.patch',
                    toolCallId: 'patch_call',
                }),
            );

            const client = createClient({ url: sqliteUrl });
            const afterBlocked = await client.execute(
                'SELECT status, awaiting_reason, primary_wait_id FROM sessions WHERE session_id = ?',
                [sessionId],
            );
            expect(afterBlocked.rows).toEqual([
                { status: 'awaiting', awaiting_reason: 'approval', primary_wait_id: 'approval_patch' },
            ]);

            // When: approval resolves and the tool finishes mid-run.
            await store.append(approvalEvent(sessionId, 'approval.updated', 'approved'));
            const afterApproval = await client.execute(
                'SELECT status, awaiting_reason FROM sessions WHERE session_id = ?',
                [sessionId],
            );
            expect(afterApproval.rows).toEqual([{ status: 'running', awaiting_reason: null }]);

            await store.append(toolCompletedEvent(sessionId));
            const afterTool = await client.execute('SELECT status FROM sessions WHERE session_id = ?', [sessionId]);
            expect(afterTool.rows).toEqual([{ status: 'running' }]);

            // When: the session stops.
            await store.append(sessionStoppedEvent(sessionId));
            const afterStopped = await client.execute('SELECT status FROM sessions WHERE session_id = ?', [sessionId]);
            expect(afterStopped.rows).toEqual([{ status: 'stopped' }]);
            client.close();
        } finally {
            await store.close();
        }
    });
});
