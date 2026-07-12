import { createClient } from '@libsql/client';
import { RunSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SqliteSessionEventStore } from '../../memory/sqlite-session-event-store.js';
import { localRuntimeDbUrl } from '../local-runtime-db.js';
import { makeTempRoot, seedOmoRoot } from './mission-run-test-support.js';
import { createRun, updateRunStatus } from './run-store.js';

const statusRowSchema = z.object({ status: z.string() });
const metadataRowSchema = z.object({ metadata_json: z.string() });

describe('mission-run session lifecycle refresh', () => {
    it('converges idle(aborted) when the final mission run settles without another session event', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const sessionId = 'session_mission_survivor';
        const store = await SqliteSessionEventStore.open({
            dataDir: root.dataDir,
            sessionId,
            now: () => '2026-07-11T12:00:00.000Z',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        await store.append({ type: 'session.started', timestamp: '2026-07-11T12:00:00.000Z', sessionId });
        await createRun(
            root,
            RunSchema.parse({
                id: 'mission_run_survivor',
                missionId: 'mission_survivor',
                sessionId,
                status: 'running',
                startedAt: '2026-07-11T12:00:01.000Z',
            }),
        );
        await store.append({
            type: 'session.abort.completed',
            timestamp: '2026-07-11T12:00:02.000Z',
            sessionId,
            sessionStop: {
                operationId: 'operation_stop',
                requestId: 'request_stop',
                reason: 'operator_aborted',
                affected: {
                    runs: 0,
                    approvals: 0,
                    sessionAwaits: 0,
                    sessionInputs: 0,
                    missionRuns: 0,
                    asyncJobs: 0,
                    toolCalls: 0,
                },
            },
        });
        const client = createClient({ url: localRuntimeDbUrl(root.dataDir) });
        await expect(sessionStatus(client, sessionId)).resolves.toBe('running');

        await updateRunStatus(
            root,
            'mission_run_survivor',
            'completed',
            {},
            {
                now: () => '2026-07-11T12:00:03.000Z',
            },
        );

        await expect(sessionStatus(client, sessionId)).resolves.toBe('idle');
        const metadata = await sessionMetadata(client, sessionId);
        expect(JSON.parse(metadata)).toMatchObject({ lifecycleReason: 'aborted' });
        client.close();
        await store.close();
    });
});

async function sessionStatus(client: ReturnType<typeof createClient>, sessionId: string): Promise<unknown> {
    return statusRowSchema.parse(
        (await client.execute('SELECT status FROM sessions WHERE session_id = ?', [sessionId])).rows[0],
    ).status;
}

async function sessionMetadata(client: ReturnType<typeof createClient>, sessionId: string): Promise<string> {
    return metadataRowSchema.parse(
        (await client.execute('SELECT metadata_json FROM sessions WHERE session_id = ?', [sessionId])).rows[0],
    ).metadata_json;
}
