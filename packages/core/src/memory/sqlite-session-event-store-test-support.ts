import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import {
    approvalEvent,
    sessionStoppedEvent as codingSessionStoppedEvent,
    diffAppliedEvent,
    providerCompletedEvent,
    providerFailedEvent,
    providerToolCallEvent,
    runEvent,
    toolFailedEvent,
} from '../session-replay-coding-test-support.js';
import { SqliteSessionEventStore, type SqliteSessionEventStoreRuntimeOptions } from './sqlite-session-event-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

export async function cleanupSqliteSessionEventStoreTestDirs(): Promise<void> {
    await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
}

export async function createSqliteSessionEventStoreTestDir(name: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), `mission-control-sqlite-store-${name}-`));
    tempDirs.push(tempDir);
    return tempDir;
}

export async function createSqliteSessionEventStoreTestDbUrl(name: string): Promise<string> {
    const tempDir = await createSqliteSessionEventStoreTestDir(name);
    return `file:${join(tempDir, 'session-events.db')}`;
}

export async function openSqliteSessionEventStoreForTests(
    input: SqliteSessionEventStoreRuntimeOptions & { readonly url: string },
): Promise<SqliteSessionEventStore> {
    const runtime = await openLocalLibsqlDb({ url: input.url });
    return SqliteSessionEventStore.fromRuntime(runtime, input);
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
        taskId: 'task_sqlite',
        message: 'completed from sqlite',
        nativeSidecarStatus: 'mock',
    };
}

export function eventWithoutSession(): AgentEvent {
    return {
        type: 'session.started',
        timestamp: '2026-06-04T10:00:00.000Z',
        nativeSidecarStatus: 'mock',
    };
}

export function detailedProjectionEvents(sessionId: string): readonly AgentEvent[] {
    return [
        sessionStartedEvent(sessionId),
        runEvent(sessionId, 'run.started', 'run started', {
            runId: 'run_1',
            command: 'wake',
            state: 'running',
        }),
        providerToolCallEvent(sessionId),
        providerCompletedEvent(sessionId, 'task_prompt_1', 'assistant summary'),
        approvalEvent(sessionId, 'approval.requested', 'pending'),
        approvalEvent(sessionId, 'approval.updated', 'approved'),
        diffAppliedEvent(sessionId),
        toolFailedEvent(sessionId),
        providerFailedEvent(sessionId),
        codingSessionStoppedEvent(sessionId),
    ];
}

export function envelope(input: {
    readonly eventId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly event: AgentEvent;
}): AgentEventEnvelope {
    return AgentEventEnvelopeSchema.parse({
        eventId: input.eventId,
        sequence: input.sequence,
        createdAt: '2026-06-04T10:00:00.000Z',
        sessionId: input.sessionId,
        durability: 'durable',
        event: input.event,
    });
}
