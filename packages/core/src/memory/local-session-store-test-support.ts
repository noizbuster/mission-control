import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { afterEach } from 'vitest';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './jsonl-session-records';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CREATED_AT = '2026-07-06T00:00:00.000Z';
export const UPDATED_AT = '2026-07-06T00:00:01.000Z';

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export type LegacyEnvelopeInput = {
    readonly eventId: string;
    readonly sequence: number;
    readonly event: AgentEvent;
};

export async function tempDataDir(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `mctrl-local-session-${name}-`));
    tempDirs.push(dir);
    return dir;
}

export async function writeLegacyJsonl(
    dataDir: string,
    sessionId: string,
    envelopes: readonly LegacyEnvelopeInput[],
): Promise<string> {
    return writeLegacySource(dataDir, sessionId, jsonlFor(sessionId, envelopes.map(envelope)));
}

export async function writeLegacySource(dataDir: string, sessionId: string, contents: string): Promise<string> {
    const sessionsDir = join(dataDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);
    await writeFile(filePath, contents, 'utf8');
    return filePath;
}

export function jsonlFor(sessionId: string, envelopes: readonly AgentEventEnvelope[]): string {
    return [
        serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId, createdAt: CREATED_AT })),
        ...envelopes.map((item) => serializeJsonlRecord(createJsonlSessionEventRecord(item))),
    ].join('');
}

export function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: CREATED_AT,
        sessionId,
        message: 'local session started',
        nativeSidecarStatus: 'mock',
    };
}

export function sessionStoppedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.stopped',
        timestamp: UPDATED_AT,
        sessionId,
        message: 'local session stopped',
        nativeSidecarStatus: 'mock',
    };
}

function envelope(input: LegacyEnvelopeInput): AgentEventEnvelope {
    return AgentEventEnvelopeSchema.parse({
        eventId: input.eventId,
        sequence: input.sequence,
        createdAt: input.event.timestamp,
        sessionId: input.event.sessionId,
        durability: 'durable',
        event: input.event,
    });
}
