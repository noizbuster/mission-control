import type { Client } from '@libsql/client';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    parseJsonlSessionLog,
    serializeJsonlRecord,
} from './jsonl-session-records.js';
import type { ImportAccumulator } from './session-import-sources.js';
import { readFile, writeFile } from 'node:fs/promises';

export function emptyImportAccumulator(): ImportAccumulator {
    return {
        importedEventCount: 0,
        importedRunCount: 0,
        skippedSourceCount: 0,
        diagnostics: [],
    };
}

export function legacyEnvelope(input: {
    readonly sessionId: string;
    readonly eventId: string;
    readonly sequence: number;
    readonly type?: AgentEvent['type'];
    readonly timestamp: string;
    readonly message: string;
}): AgentEventEnvelope {
    const event: AgentEvent = {
        type: input.type ?? 'log',
        timestamp: input.timestamp,
        sessionId: input.sessionId,
        message: input.message,
    };
    return {
        eventId: input.eventId,
        sequence: input.sequence,
        createdAt: input.timestamp,
        sessionId: input.sessionId,
        durability: 'durable',
        event,
    };
}

export async function readLegacyEnvelopes(input: {
    readonly filePath: string;
    readonly sessionId: string;
}): Promise<readonly AgentEventEnvelope[]> {
    const contents = await readFile(input.filePath, 'utf8');
    return parseJsonlSessionLog({ ...input, contents }).envelopes;
}

export async function writeLegacyLog(input: {
    readonly filePath: string;
    readonly sessionId: string;
    readonly createdAt: string;
    readonly envelopes: readonly AgentEventEnvelope[];
}): Promise<void> {
    const contents = [
        serializeJsonlRecord(createJsonlSessionLogHeader(input)),
        ...input.envelopes.map((envelope) => serializeJsonlRecord(createJsonlSessionEventRecord(envelope))),
    ].join('');
    await writeFile(input.filePath, contents, 'utf8');
}

export async function sessionSummary(client: Client, sessionId: string): Promise<Readonly<Record<string, unknown>>> {
    const result = await client.execute({
        sql: `
            SELECT status, created_at, updated_at, last_activity_at, stopped_at, last_event_seq
            FROM sessions WHERE session_id = ?
        `,
        args: [sessionId],
    });
    return result.rows[0] ?? {};
}
