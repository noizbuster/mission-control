import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { openLocalLibsqlDb } from '../db/local-libsql-db';
import {
    approvalEvent,
    diffAppliedEvent,
    envelope,
    providerCompletedEvent,
    providerFailedEvent,
    providerToolCallEvent,
    runEvent,
    sessionStoppedEvent,
    toolFailedEvent,
} from '../session-replay-coding-test-support';
import { createSqliteSessionProjectionStore, type SqliteSessionProjectionStore } from './sqlite-session-projection';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SESSION_ID = 'session_sqlite_projection_test';
export const CREATED_AT = '2026-06-05T09:59:59.000Z';

const tempDirs: string[] = [];

export async function cleanupSqliteSessionProjectionTestDirs(): Promise<void> {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function tempDbUrl(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `mctrl-sqlite-projection-${name}-`));
    tempDirs.push(dir);
    return `file:${join(dir, 'sessions.db')}`;
}

export async function openSqliteSessionProjectionStoreForTests(url: string): Promise<SqliteSessionProjectionStore> {
    return createSqliteSessionProjectionStore(await openLocalLibsqlDb({ url }));
}

export function completeProjectionEvents(sessionId: string): readonly AgentEventEnvelope[] {
    return [
        envelope(sessionStartedEvent(sessionId), 1, 'event_session_started'),
        envelope(
            runEvent(sessionId, 'run.started', 'run started', {
                runId: 'run_1',
                command: 'wake',
                state: 'running',
            }),
            2,
            'event_run_started',
        ),
        envelope(providerToolCallEvent(sessionId), 3, 'event_provider_tool_call'),
        envelope(providerCompletedEvent(sessionId, 'task_prompt_1', 'assistant summary'), 4, 'event_provider_message'),
        envelope(approvalEvent(sessionId, 'approval.requested', 'pending'), 5, 'event_approval_pending'),
        envelope(approvalEvent(sessionId, 'approval.updated', 'approved'), 6, 'event_approval_approved'),
        envelope(diffAppliedEvent(sessionId), 7, 'event_diff_applied'),
        envelope(toolFailedEvent(sessionId), 8, 'event_tool_failed'),
        envelope(providerFailedEvent(sessionId), 9, 'event_provider_failed'),
        envelope(sessionStoppedEvent(sessionId), 10, 'event_session_stopped'),
    ];
}

export function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: CREATED_AT,
        sessionId,
        message: 'mission-control session started',
    };
}
