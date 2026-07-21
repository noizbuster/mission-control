import { afterEach, describe, expect, it } from 'vitest';
import { openLocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { runEvent } from '../session-replay-coding-test-support';
import {
    cleanupSqliteSessionEventStoreTestDirs,
    createSqliteSessionEventStoreTestDbUrl,
    openSqliteSessionEventStoreForTests,
    sessionStartedEvent,
    taskCompletedEvent,
} from './sqlite-session-event-store-test-support';

afterEach(cleanupSqliteSessionEventStoreTestDirs);

describe('SQLite session event transaction rollback', () => {
    it('rolls back a failure after event insert and accepts the next contiguous append', async () => {
        // Given: one committed event and a trigger that rejects the next append during projection replacement.
        const sessionId = 'session_task_11_transaction';
        const url = await createSqliteSessionEventStoreTestDbUrl('transaction-rollback');
        const observer = await openLocalLibsqlDb({ url });
        try {
            const store = await openSqliteSessionEventStoreForTests({
                url,
                sessionId,
                createEventId: (_event, sequence) => `event_${sequence}`,
            });
            try {
                await store.append(sessionStartedEvent(sessionId));
                await runLocalLibsqlWrite(observer, (client) =>
                    client
                        .execute(`
                CREATE TRIGGER reject_task_11_projection
                BEFORE INSERT ON session_projection_runs
                WHEN NEW.run_id = 'run_task_11_rejected'
                BEGIN SELECT RAISE(ABORT, 'injected post-event failure'); END
            `)
                        .then(() => undefined),
                );

                // When: production append inserts the event and advances sequence state before the trigger aborts projection.
                await expect(
                    store.append(
                        runEvent(sessionId, 'run.started', 'injected run', {
                            runId: 'run_task_11_rejected',
                            command: 'wake',
                            state: 'running',
                        }),
                    ),
                ).rejects.toThrow(/injected post-event failure/u);

                // Then: no partial event/projection/sequence state survives and no write transaction remains open.
                expect(
                    (
                        await observer.client.execute(
                            'SELECT seq, event_id FROM session_events WHERE session_id = ? ORDER BY seq',
                            [sessionId],
                        )
                    ).rows,
                ).toEqual([{ seq: 0, event_id: 'event_0' }]);
                expect(
                    (
                        await observer.client.execute(
                            'SELECT next_seq FROM session_event_sequences WHERE session_id = ?',
                            [sessionId],
                        )
                    ).rows,
                ).toEqual([{ next_seq: 1 }]);
                expect(
                    (
                        await observer.client.execute(
                            'SELECT last_event_seq, metadata_json FROM sessions WHERE session_id = ?',
                            [sessionId],
                        )
                    ).rows,
                ).toEqual([
                    {
                        last_event_seq: 0,
                        metadata_json: '{"eventCount":1,"lastEventId":"event_0","lastEventType":"session.started","messageCount":0}',
                    },
                ]);
                expect(
                    (
                        await observer.client.execute(
                            "SELECT COUNT(*) AS count FROM session_projection_runs WHERE run_id = 'run_task_11_rejected'",
                        )
                    ).rows,
                ).toEqual([{ count: 0 }]);
                await runLocalLibsqlWrite(observer, async (client) => {
                    await client.execute('BEGIN IMMEDIATE TRANSACTION');
                    await client.execute('ROLLBACK');
                });

                await runLocalLibsqlWrite(observer, (client) =>
                    client.execute('DROP TRIGGER reject_task_11_projection').then(() => undefined),
                );
                await store.append(taskCompletedEvent(sessionId));
                expect((await store.getReplay(sessionId)).envelopes.map((envelope) => envelope.sequence)).toEqual([
                    0, 1,
                ]);
                expect((await store.getReplay(sessionId)).envelopes.map((envelope) => envelope.eventId)).toEqual([
                    'event_0',
                    'event_1',
                ]);
                expect((await observer.client.execute('PRAGMA integrity_check')).rows).toEqual([
                    { integrity_check: 'ok' },
                ]);
            } finally {
                await store.close();
            }
        } finally {
            observer.close();
        }
    });
});
