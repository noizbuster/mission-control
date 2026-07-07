import type { AgentEvent } from '@mission-control/protocol';
import { afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

export async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-jsonl-'));
    tempDirs.push(dataDir);
    return dataDir;
}

export async function readJsonlRecords(filePath: string): Promise<readonly Record<string, unknown>[]> {
    const contents = await readFile(filePath, 'utf8');
    return contents
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map(parseJsonRecord);
}

export function envelopeSequence(record: JsonlRecordView): unknown {
    const event = eventEnvelopeFromRecord(record);
    return event?.sequence;
}

export function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: '2026-06-04T10:00:00.000Z',
        sessionId,
        nativeSidecarStatus: 'mock',
    };
}

export function taskCompletedEvent(sessionId: string): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: '2026-06-04T10:00:01.000Z',
        sessionId,
        taskId: 'task_jsonl',
        message: 'completed from jsonl',
        nativeSidecarStatus: 'mock',
    };
}

type JsonlRecordView = Record<string, unknown> & { readonly event?: unknown };

function parseJsonRecord(line: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
        throw new TypeError('JSONL line did not parse to an object');
    }
    return parsed;
}

function eventEnvelopeFromRecord(record: JsonlRecordView): { readonly sequence?: unknown } | undefined {
    const event = record.event;
    return isRecord(event) ? event : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
