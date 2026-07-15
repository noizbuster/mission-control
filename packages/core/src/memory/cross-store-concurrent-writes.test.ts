import { RunSchema, WorkflowSpecSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqlTaskRuntimeServices } from '../agents/sql-task-runtime-services';
import { SqlContextEpochStore } from '../context/system-context-epoch-store';
import { runLocalLibsqlWrite } from '../db/local-libsql-db';
import { openMissionControlDb } from '../db/mission-control-db';
import { materializeMission } from '../runtime/mission-run/mission-run-service';
import { createMission } from '../runtime/mission-run/mission-store';
import { createRun } from '../runtime/mission-run/run-store';
import { SqlSessionInputDelivery } from '../runtime/session-input-delivery-sql';
import { openLocalSessionEventStore } from './local-session-store-open';
import { TursoPersistentStore } from './turso-persistent-store';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];
const timestamp = '2026-07-12T12:00:00.000Z';
afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('cross-store concurrent writes', () => {
    it('preserves every shared-database row and contiguous event sequence under one concurrent wave', async () => {
        // Given: every product store facade targets one Mission Control data directory.
        const root = await mkdtemp(join(tmpdir(), 'mctrl-task-11-cross-store-'));
        tempRoots.push(root);
        const dataDir = join(root, 'data');
        const omoRoot = join(root, 'workspace');
        await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(join(omoRoot, '.omo'), { recursive: true })]);
        const firstSessionId = 'session_task_11_first';
        const secondSessionId = 'session_task_11_second';
        const cleanups: Array<() => Promise<void> | void> = [];
        try {
            const firstStore = await openLocalSessionEventStore({
                dataDir,
                sessionId: firstSessionId,
                createEventId: (_event, sequence) => `first_${sequence}`,
            });
            cleanups.push(() => firstStore.close());
            const secondStore = await openLocalSessionEventStore({
                dataDir,
                sessionId: secondSessionId,
                createEventId: (_event, sequence) => `second_${sequence}`,
            });
            cleanups.push(() => secondStore.close());
            const memoryStore = TursoPersistentStore.fromRuntime(await openMissionControlDb({ dataDir }));
            cleanups.push(() => memoryStore.close());
            const delivery = await SqlSessionInputDelivery.open({ dataDir });
            cleanups.push(() => delivery.close());
            const epochs = await SqlContextEpochStore.open({ dataDir });
            cleanups.push(() => epochs.close());
            const services = await createSqlTaskRuntimeServices(dataDir, {
                maxConcurrency: 1,
                recoverActiveJobs: false,
            });
            cleanups.push(() => services.close());
            const mission = materializeMission(
                WorkflowSpecSchema.parse({
                    name: 'task-11-cross-store',
                    graph: { id: 'task-11-graph', entryNodeId: 'start', nodes: [{ id: 'start', kind: 'llm' }] },
                }),
            );
            const run = RunSchema.parse({
                id: randomUUID(),
                missionId: mission.id,
                sessionId: firstSessionId,
                status: 'pending',
            });
            services.runtimeRegistry.adopt({
                id: 'agent-task-11',
                displayName: 'deep',
                kind: 'sub',
                parentId: 'Main',
                status: 'running',
                sessionId: 'child-task-11',
            });
            const job = services.jobManager.startJob({
                sessionId: 'child-task-11',
                parentSessionId: 'parent-task-11',
                agentId: 'agent-task-11',
                blocking: false,
                execute: async () => ({ status: 'completed', output: 'cross-store-result' }),
            });
            // When: unrelated owners concurrently append two streams and mutate every runtime projection family.
            await Promise.all([
                firstStore.append(sessionStarted(firstSessionId)),
                firstStore.append(taskCompleted(firstSessionId)),
                secondStore.append(sessionStarted(secondSessionId)),
                secondStore.append(taskCompleted(secondSessionId)),
                memoryStore.set('shared-key', 'task-11', { value: 'shared-memory' }),
                createMission({ omoRoot, dataDir }, mission),
                createRun({ omoRoot, dataDir }, run),
                delivery.admitInput(
                    firstSessionId,
                    { inputId: 'input-task-11', prompt: 'continue concurrently' },
                    'queue',
                ),
                epochs.recordEpoch({
                    sessionId: secondSessionId,
                    epoch: 1,
                    sourceId: 'task-11/source',
                    updateText: 'concurrent context',
                }),
                services.mirror.startSubagentWait({
                    parentSessionId: 'parent-task-11',
                    childSessionId: 'child-task-11',
                    agentId: 'agent-task-11',
                    mode: 'sync',
                }),
                services.jobManager.awaitJob(job.jobId),
            ]);
            await services.flush();
            // Then: all rows survive, both event streams are contiguous, integrity is clean, and a follow-up write succeeds.
            const runtime = await openMissionControlDb({ dataDir });
            try {
                const events = await runtime.client.execute(
                    'SELECT session_id, seq, event_id FROM session_events WHERE session_id IN (?, ?) ORDER BY session_id, seq',
                    [firstSessionId, secondSessionId],
                );
                expect(events.rows).toEqual([
                    { session_id: firstSessionId, seq: 0, event_id: 'first_0' },
                    { session_id: firstSessionId, seq: 1, event_id: 'first_1' },
                    { session_id: secondSessionId, seq: 0, event_id: 'second_0' },
                    { session_id: secondSessionId, seq: 1, event_id: 'second_1' },
                ]);
                expect(
                    (
                        await runtime.client.execute(
                            'SELECT session_id, last_event_seq, metadata_json FROM sessions WHERE session_id IN (?, ?) ORDER BY session_id',
                            [firstSessionId, secondSessionId],
                        )
                    ).rows,
                ).toEqual([
                    {
                        session_id: firstSessionId,
                        last_event_seq: 1,
                        metadata_json: '{"eventCount":2,"lastEventId":"first_1","lastEventType":"task.completed"}',
                    },
                    {
                        session_id: secondSessionId,
                        last_event_seq: 1,
                        metadata_json: '{"eventCount":2,"lastEventId":"second_1","lastEventType":"task.completed"}',
                    },
                ]);
                expect(
                    (
                        await runtime.client.execute(
                            'SELECT session_id, next_seq FROM session_event_sequences WHERE session_id IN (?, ?) ORDER BY session_id',
                            [firstSessionId, secondSessionId],
                        )
                    ).rows,
                ).toEqual([
                    { session_id: firstSessionId, next_seq: 2 },
                    { session_id: secondSessionId, next_seq: 2 },
                ]);
                expect(
                    await selectRows(runtime, "SELECT value FROM memory_entries WHERE namespace = 'task-11'"),
                ).toEqual([{ value: '{"value":"shared-memory"}' }]);
                expect(
                    await selectRows(runtime, 'SELECT mission_id FROM missions WHERE mission_id = ?', [mission.id]),
                ).toEqual([{ mission_id: mission.id }]);
                expect(await selectRows(runtime, 'SELECT run_id FROM mission_runs WHERE run_id = ?', [run.id])).toEqual(
                    [{ run_id: run.id }],
                );
                expect(
                    await selectRows(
                        runtime,
                        "SELECT input_id, status FROM session_inputs WHERE input_id = 'input-task-11'",
                    ),
                ).toEqual([{ input_id: 'input-task-11', status: 'admitted' }]);
                expect(
                    await selectRows(
                        runtime,
                        "SELECT epoch, source_id FROM context_epochs WHERE source_id = 'task-11/source'",
                    ),
                ).toEqual([{ epoch: 1, source_id: 'task-11/source' }]);
                expect(
                    await selectRows(
                        runtime,
                        "SELECT agent_id, status FROM runtime_agents WHERE agent_id = 'agent-task-11'",
                    ),
                ).toEqual([{ agent_id: 'agent-task-11', status: 'running' }]);
                expect(
                    await selectRows(runtime, 'SELECT job_id, status FROM async_jobs WHERE job_id = ?', [job.jobId]),
                ).toEqual([{ job_id: job.jobId, status: 'completed' }]);
                expect(
                    await selectRows(
                        runtime,
                        "SELECT parent_session_id, child_session_id, kind FROM session_relations WHERE child_session_id = 'child-task-11'",
                    ),
                ).toEqual([
                    { parent_session_id: 'parent-task-11', child_session_id: 'child-task-11', kind: 'subagent' },
                ]);
                expect((await runtime.client.execute('PRAGMA integrity_check')).rows).toEqual([
                    { integrity_check: 'ok' },
                ]);
                await runLocalLibsqlWrite(runtime, (client) =>
                    client
                        .execute({
                            sql: 'INSERT INTO memory_entries (namespace, key, value, created_at) VALUES (?, ?, ?, ?)',
                            args: ['task-11', 'follow-up', 'true', timestamp],
                        })
                        .then(() => undefined),
                );
                expect(await selectRows(runtime, "SELECT key FROM memory_entries WHERE key = 'follow-up'")).toEqual([
                    { key: 'follow-up' },
                ]);
            } finally {
                runtime.close();
            }
        } finally {
            await closeResources(cleanups);
        }
    }, 15_000);
});
type QueryRuntime = Awaited<ReturnType<typeof openMissionControlDb>>;
async function closeResources(cleanups: readonly (() => Promise<void> | void)[]): Promise<void> {
    const errors: Error[] = [];
    for (const cleanup of [...cleanups].reverse()) {
        try {
            await cleanup();
        } catch (error: unknown) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'cross-store resource cleanup failed');
}
async function selectRows(runtime: QueryRuntime, sql: string, args: string[] = []) {
    return (await runtime.client.execute({ sql, args })).rows;
}
function sessionStarted(sessionId: string) {
    return {
        type: 'session.started' as const,
        timestamp,
        sessionId,
        nativeSidecarStatus: 'mock' as const,
    };
}

function taskCompleted(sessionId: string) {
    return {
        type: 'task.completed' as const,
        timestamp: '2026-07-12T12:00:01.000Z',
        sessionId,
        taskId: `task-${sessionId}`,
        message: 'completed concurrently',
        nativeSidecarStatus: 'mock' as const,
    };
}
