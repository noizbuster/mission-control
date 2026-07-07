import type { Client } from '@libsql/client';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { type LocalLibsqlDb, openLocalLibsqlDb } from '../db/local-libsql-db.js';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './jsonl-session-records.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SESSION_IMPORT_TEST_SESSION_ID = 'legacy_session_1';
export const SESSION_IMPORT_TEST_CREATED_AT = '2026-06-30T01:00:00.000Z';

export type LegacyFixture = {
    readonly root: string;
    readonly dataDir: string;
    readonly omoRoot: string;
    readonly jsonlPath: string;
    readonly runPath: string;
};

type CountRow = {
    readonly count: unknown;
};

export async function openMigratedTestDb(): Promise<LocalLibsqlDb> {
    return openLocalLibsqlDb({ url: ':memory:' });
}

export async function writeLegacyFixture(input: {
    readonly tmpRoot: string;
    readonly name: string;
}): Promise<LegacyFixture> {
    const root = join(input.tmpRoot, input.name);
    const dataDir = join(root, 'data');
    const sessionsDir = join(dataDir, 'sessions');
    const omoRoot = join(root, '.omo');
    const runsDir = join(omoRoot, 'runs');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(runsDir, { recursive: true });

    const jsonlPath = join(sessionsDir, `${SESSION_IMPORT_TEST_SESSION_ID}.jsonl`);
    const runPath = join(runsDir, 'run_legacy.json');
    await writeFile(jsonlPath, legacyJsonl(), 'utf8');
    await writeFile(runPath, `${JSON.stringify(runRecord())}\n`, 'utf8');

    return { root, dataDir, omoRoot, jsonlPath, runPath };
}

export async function readSourceBytes(fixture: LegacyFixture): Promise<Readonly<Record<string, string>>> {
    return {
        jsonl: await readFile(fixture.jsonlPath, 'utf8'),
        run: await readFile(fixture.runPath, 'utf8'),
    };
}

export async function countRows(client: Client, tableName: string): Promise<number> {
    const result = await client.execute(`SELECT COUNT(*) AS count FROM ${tableName}`);
    const row = result.rows[0];
    if (!hasCountColumn(row)) {
        return 0;
    }
    return Number(row.count ?? 0);
}

function hasCountColumn(row: unknown): row is CountRow {
    return typeof row === 'object' && row !== null && 'count' in row;
}

export async function readMissionRunDbRow(client: Client, runId: string): Promise<Readonly<Record<string, unknown>>> {
    const result = await client.execute({
        sql: 'SELECT run_id, prompt, updated_at, ended_at, passthrough_json FROM mission_runs WHERE run_id = ?',
        args: [runId],
    });
    return result.rows[0] ?? {};
}

function runRecord(): unknown {
    return {
        id: 'run_legacy',
        missionId: 'mission_legacy',
        status: 'completed',
        sessionId: SESSION_IMPORT_TEST_SESSION_ID,
        prompt: 'legacy prompt',
        cost: { cents: 0, inputTokens: 0, outputTokens: 0, modelCalls: 0 },
        attempt: 1,
        startedAt: SESSION_IMPORT_TEST_CREATED_AT,
        endedAt: '2026-06-30T01:00:02.000Z',
    };
}

function legacyJsonl(): string {
    return [
        serializeJsonlRecord(
            createJsonlSessionLogHeader({
                sessionId: SESSION_IMPORT_TEST_SESSION_ID,
                createdAt: SESSION_IMPORT_TEST_CREATED_AT,
            }),
        ),
        serializeJsonlRecord(createJsonlSessionEventRecord(envelope('event_started', 0, sessionStartedEvent()))),
        serializeJsonlRecord(createJsonlSessionEventRecord(envelope('event_stopped', 1, sessionStoppedEvent()))),
    ].join('');
}

function envelope(eventId: string, sequence: number, event: AgentEvent): AgentEventEnvelope {
    return {
        eventId,
        sequence,
        createdAt: event.timestamp,
        sessionId: SESSION_IMPORT_TEST_SESSION_ID,
        durability: 'durable',
        event,
    };
}

function sessionStartedEvent(): AgentEvent {
    return {
        type: 'session.started',
        timestamp: SESSION_IMPORT_TEST_CREATED_AT,
        sessionId: SESSION_IMPORT_TEST_SESSION_ID,
        message: 'legacy text is imported as data only: $(echo no-exec)',
    };
}

function sessionStoppedEvent(): AgentEvent {
    return {
        type: 'session.stopped',
        timestamp: '2026-06-30T01:00:02.000Z',
        sessionId: SESSION_IMPORT_TEST_SESSION_ID,
        message: 'legacy session stopped',
    };
}
