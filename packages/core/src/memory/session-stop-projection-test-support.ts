import type { Client } from '@libsql/client';
import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { SESSION_ID } from './session-stop-projection-events-test-support.js';
import { SqliteSessionEventStore } from './sqlite-session-event-store.js';

const sessionRowSchema = z.object({ status: z.string(), metadata_json: z.string() });
const inputRowSchema = z.object({ input_id: z.string(), status: z.string() });
const approvalRowSchema = z.object({ approval_id: z.string(), status: z.string() });
const waitRowSchema = z.object({ wait_id: z.string(), reason: z.string(), status: z.string() });
const failureRowSchema = z.object({ error_json: z.string() });
const eventRowSchema = z.object({ type: z.string(), payload_json: z.string() });
const errorJsonSchema = z.object({ code: z.string() });

export async function openStore(url: string): Promise<SqliteSessionEventStore> {
    return SqliteSessionEventStore.fromRuntime(await openLocalLibsqlDb({ url }), {
        sessionId: SESSION_ID,
        now: () => '2026-07-11T10:00:10.000Z',
        createEventId: (_event, sequence) => `event_${sequence}`,
    });
}

export async function insertSurvivor(client: Client, kind: 'mission' | 'job'): Promise<void> {
    if (kind === 'mission') {
        await client.execute({
            sql: 'INSERT INTO mission_runs (run_id, mission_id, session_id, status, created_at, updated_at, passthrough_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [
                'mission_run',
                'mission',
                SESSION_ID,
                'running',
                '2026-07-11T10:00:00.000Z',
                '2026-07-11T10:00:00.000Z',
                '{}',
            ],
        });
        return;
    }
    await client.execute({
        sql: 'INSERT INTO async_jobs (job_id, parent_session_id, status, queued_at, metadata_json) VALUES (?, ?, ?, ?, ?)',
        args: ['job_active', SESSION_ID, 'running', '2026-07-11T10:00:00.000Z', '{}'],
    });
}

export async function settleSurvivor(client: Client, kind: 'mission' | 'job'): Promise<void> {
    const table = kind === 'mission' ? 'mission_runs' : 'async_jobs';
    const id = kind === 'mission' ? 'mission_run' : 'job_active';
    const column = kind === 'mission' ? 'run_id' : 'job_id';
    await client.execute({
        sql: `UPDATE ${table} SET status = ? WHERE ${column} = ?`,
        args: [kind === 'mission' ? 'completed' : 'cancelled', id],
    });
}

export async function sessionStatus(client: Client): Promise<string> {
    return sessionRowSchema
        .pick({ status: true })
        .parse((await client.execute('SELECT status FROM sessions WHERE session_id = ?', [SESSION_ID])).rows[0]).status;
}

export async function readSessionRow(client: Client): Promise<z.infer<typeof sessionRowSchema>> {
    return sessionRowSchema.parse(
        (await client.execute('SELECT status, metadata_json FROM sessions WHERE session_id = ?', [SESSION_ID])).rows[0],
    );
}

export async function readProjectionRows(url: string) {
    const runtime = await openLocalLibsqlDb({ url });
    const client = runtime.client;
    const session = await readSessionRow(client);
    const inputs = (
        await client.execute('SELECT input_id, status FROM session_inputs WHERE session_id = ? ORDER BY input_id', [
            SESSION_ID,
        ])
    ).rows.map((row) => inputRowSchema.parse(row));
    const approvals = (
        await client.execute('SELECT approval_id, status FROM approvals WHERE session_id = ? ORDER BY approval_id', [
            SESSION_ID,
        ])
    ).rows.map((row) => approvalRowSchema.parse(row));
    const waits = (
        await client.execute(
            'SELECT wait_id, reason, status FROM session_awaits WHERE session_id = ? ORDER BY wait_id',
            [SESSION_ID],
        )
    ).rows.map((row) => waitRowSchema.parse(row));
    const failures = (
        await client.execute('SELECT error_json FROM provider_failures WHERE session_id = ? ORDER BY event_id', [
            SESSION_ID,
        ])
    ).rows.map((row) => failureRowSchema.parse(row));
    const events = (
        await client.execute('SELECT type, payload_json FROM session_events WHERE session_id = ? ORDER BY seq', [
            SESSION_ID,
        ])
    ).rows.map((row) => eventRowSchema.parse(row));
    runtime.close();
    return {
        session,
        inputs,
        approvals,
        waits,
        failureCodes: failures.map((row) => errorJsonSchema.parse(JSON.parse(row.error_json)).code),
        eventTypes: events.map((row) => row.type),
        auditTypes: events.map((row) => {
            const event = AgentEventEnvelopeSchema.parse(JSON.parse(row.payload_json)).event;
            return event.providerStreamChunk?.kind === 'response_failed'
                ? `${row.type}:${event.providerStreamChunk.error.code}`
                : row.type;
        }),
    };
}
