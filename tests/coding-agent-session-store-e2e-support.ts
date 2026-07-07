import { type LocalLibsqlDb } from '../packages/core/src/db/local-libsql-db.js';
import { openLocalSessionEventStore } from '../packages/core/src/index.js';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from '../packages/core/src/memory/jsonl-session-records.js';
import type { AgentEvent, AgentEventEnvelope } from '../packages/protocol/src/index.js';
import { AgentEventEnvelopeSchema } from '../packages/protocol/src/index.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CREATED_AT = '2026-07-06T00:00:00.000Z';

export * from './coding-agent-session-store-e2e-events.js';

export type SessionStatusRow = {
    readonly session_id: string;
    readonly status: string;
    readonly awaiting_reason: string | null;
    readonly primary_wait_id: string | null;
    readonly exported_at: string | null;
};

export type SessionWaitRow = {
    readonly session_id: string;
    readonly reason: string;
    readonly source_kind: string;
    readonly source_id: string;
    readonly status: string;
};

export type SessionDetailRows = {
    readonly messages: readonly Readonly<Record<string, unknown>>[];
    readonly tools: readonly Readonly<Record<string, unknown>>[];
    readonly approvals: readonly Readonly<Record<string, unknown>>[];
    readonly failures: readonly Readonly<Record<string, unknown>>[];
};

export type SessionJobRow = {
    readonly job_id: string;
    readonly child_session_id: string | null;
    readonly parent_session_id: string | null;
    readonly status: string;
};

export type SessionStoreE2eDbRowsArtifact = {
    readonly capturedAt: string;
    readonly statusRows: readonly SessionStatusRow[];
    readonly waitRows: readonly SessionWaitRow[];
    readonly publicListOutput?: string;
    readonly publicUserShow?: Readonly<Record<string, unknown>>;
    readonly publicSubagentShow?: Readonly<Record<string, unknown>>;
    readonly detailRows?: SessionDetailRows;
    readonly jobRows?: readonly SessionJobRow[];
};

export async function tempDataDir(tempDirs: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-session-e2e-'));
    tempDirs.push(dir);
    return dir;
}

export async function appendNativeEvents(
    dataDir: string,
    sessionId: string,
    events: readonly AgentEvent[],
): Promise<void> {
    const store = await openLocalSessionEventStore({
        dataDir,
        sessionId,
        now: () => CREATED_AT,
        createEventId: (event, sequence) => `${sessionId}_${sequence}_${event.type.replaceAll('.', '_')}`,
    });
    try {
        for (const event of events) {
            await store.append(event);
        }
    } finally {
        await store.close();
    }
}

export async function writeLegacyJsonl(
    dataDir: string,
    sessionId: string,
    envelopes: readonly AgentEventEnvelope[],
): Promise<void> {
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await writeFile(
        join(dataDir, 'sessions', `${sessionId}.jsonl`),
        [
            serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId, createdAt: CREATED_AT })),
            ...envelopes.map((item) => serializeJsonlRecord(createJsonlSessionEventRecord(item))),
        ].join(''),
        'utf8',
    );
}

export function envelope(sessionId: string, sequence: number, eventId: string, event: AgentEvent): AgentEventEnvelope {
    return AgentEventEnvelopeSchema.parse({
        eventId,
        sequence,
        createdAt: event.timestamp,
        sessionId,
        durability: 'durable',
        event,
    });
}

export async function readStatusRows(runtime: LocalLibsqlDb): Promise<readonly SessionStatusRow[]> {
    const result = await runtime.client.execute(
        'SELECT session_id, status, awaiting_reason, primary_wait_id, exported_at FROM sessions ORDER BY session_id',
    );
    return result.rows.map(sessionStatusRowFrom);
}

export async function readWaitRows(runtime: LocalLibsqlDb): Promise<readonly SessionWaitRow[]> {
    const result = await runtime.client.execute(
        'SELECT session_id, reason, source_kind, source_id, status FROM session_awaits ORDER BY session_id, reason',
    );
    return result.rows.map(waitRowFrom);
}

export async function readDetailRows(runtime: LocalLibsqlDb, sessionId: string): Promise<SessionDetailRows> {
    const messages = await runtime.client.execute({
        sql: 'SELECT message_id, role FROM session_messages WHERE session_id = ? ORDER BY seq',
        args: [sessionId],
    });
    const tools = await runtime.client.execute({
        sql: 'SELECT tool_call_id, name, status FROM tool_calls WHERE session_id = ? ORDER BY tool_call_id',
        args: [sessionId],
    });
    const approvals = await runtime.client.execute({
        sql: 'SELECT approval_id, status FROM approvals WHERE session_id = ? ORDER BY approval_id',
        args: [sessionId],
    });
    const failures = await runtime.client.execute({
        sql: 'SELECT event_id, request_id FROM provider_failures WHERE session_id = ? ORDER BY event_id',
        args: [sessionId],
    });
    return {
        messages: messages.rows,
        tools: tools.rows,
        approvals: approvals.rows,
        failures: failures.rows,
    };
}

export async function readJobRows(runtime: LocalLibsqlDb): Promise<readonly SessionJobRow[]> {
    const result = await runtime.client.execute(
        "SELECT job_id, child_session_id, parent_session_id, status, COALESCE(json_extract(metadata_json, '$.blocking'), 0) AS blocking FROM async_jobs ORDER BY job_id",
    );
    return result.rows.map(jobRowFrom);
}

export async function writeDbRowsArtifact(filePath: string, artifact: SessionStoreE2eDbRowsArtifact): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

function jobRowFrom(row: unknown): SessionJobRow {
    return {
        job_id: requiredString(row, 'job_id'),
        child_session_id: nullableString(row, 'child_session_id'),
        parent_session_id: nullableString(row, 'parent_session_id'),
        status: requiredString(row, 'status'),
    };
}

function sessionStatusRowFrom(row: unknown): SessionStatusRow {
    return {
        session_id: requiredString(row, 'session_id'),
        status: requiredString(row, 'status'),
        awaiting_reason: nullableString(row, 'awaiting_reason'),
        primary_wait_id: nullableString(row, 'primary_wait_id'),
        exported_at: nullableString(row, 'exported_at'),
    };
}

function waitRowFrom(row: unknown): SessionWaitRow {
    return {
        session_id: requiredString(row, 'session_id'),
        reason: requiredString(row, 'reason'),
        source_kind: requiredString(row, 'source_kind'),
        source_id: requiredString(row, 'source_id'),
        status: requiredString(row, 'status'),
    };
}

function requiredString(row: unknown, key: string): string {
    const value = field(row, key);
    if (typeof value !== 'string') {
        throw new TypeError(`expected string ${key}`);
    }
    return value;
}

function nullableString(row: unknown, key: string): string | null {
    const value = field(row, key);
    if (value === null || typeof value === 'string') {
        return value;
    }
    throw new TypeError(`expected nullable string ${key}`);
}

function field(row: unknown, key: string): unknown {
    if (typeof row !== 'object' || row === null) {
        throw new TypeError(`expected row object for ${key}`);
    }
    return Reflect.get(row, key);
}
