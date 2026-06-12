import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
    approvalEvent,
    diffAppliedEvent,
    envelope,
    providerFailedEvent,
    runEvent,
    sessionStoppedEvent,
    toolFailedEvent,
} from '../session-replay-coding-test-support.js';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './jsonl-session-records.js';
import { createFileSessionIndexStore, rebuildSessionIndexFromJsonl } from './session-index-file-store.js';
import type { SessionIndexStore } from './session-index-types.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_ID = 'session_index_test';
const CREATED_AT = '2026-06-05T09:59:59.000Z';
const TMP_ROOT = join(process.cwd(), 'tmp', 'session-index-tests');

describe('session index rebuild', () => {
    afterEach(async () => {
        await rm(TMP_ROOT, { recursive: true, force: true });
    });

    it('rebuilds query records from authoritative JSONL replay', async () => {
        // Given: a durable JSONL log covering sessions, runs, approvals, tools, and provider failures.
        const indexPath = await indexPathFor('query-coverage');
        const store = createFileSessionIndexStore({ indexPath });
        const contents = jsonlContents(SESSION_ID, [
            envelope(sessionStartedEvent(SESSION_ID), 1, 'event_session_started'),
            envelope(
                runEvent(SESSION_ID, 'run.started', 'run started', {
                    runId: 'run_1',
                    command: 'wake',
                    state: 'running',
                }),
                2,
                'event_run_started',
            ),
            envelope(approvalEvent(SESSION_ID, 'approval.requested', 'pending'), 3, 'event_approval_pending'),
            envelope(approvalEvent(SESSION_ID, 'approval.updated', 'approved'), 4, 'event_approval_approved'),
            envelope(diffAppliedEvent(SESSION_ID), 5, 'event_diff_applied'),
            envelope(toolFailedEvent(SESSION_ID), 6, 'event_tool_failed'),
            envelope(providerFailedEvent(SESSION_ID), 7, 'event_provider_failed'),
            envelope(sessionStoppedEvent(SESSION_ID), 8, 'event_session_stopped'),
        ]);

        // When: the index is rebuilt from JSONL and reopened from disk.
        const result = await rebuildSessionIndexFromJsonl({
            store,
            sessionId: SESSION_ID,
            filePath: 'sessions/session_index_test.jsonl',
            contents,
        });
        const reopened = createFileSessionIndexStore({ indexPath });

        // Then: every query surface is populated from derived records only.
        expect(result.indexedRecords).toBe(5);
        await expectQueryCoverage(reopened, SESSION_ID);
    });

    it('replaces stale derived records when the JSONL source changes', async () => {
        // Given: an existing derived index for a previous version of the same session log.
        const store = createFileSessionIndexStore({ indexPath: await indexPathFor('stale-rebuild') });
        await rebuildSessionIndexFromJsonl({
            store,
            sessionId: SESSION_ID,
            filePath: 'sessions/session_index_test.jsonl',
            contents: jsonlContents(SESSION_ID, [
                envelope(sessionStartedEvent(SESSION_ID), 1, 'event_session_started'),
                envelope(
                    runEvent(SESSION_ID, 'run.started', 'old run started', {
                        runId: 'old_run',
                        command: 'wake',
                        state: 'running',
                    }),
                    2,
                    'event_old_run_started',
                ),
            ]),
        });

        // When: the same session is rebuilt from the current JSONL source of truth.
        await rebuildSessionIndexFromJsonl({
            store,
            sessionId: SESSION_ID,
            filePath: 'sessions/session_index_test.jsonl',
            contents: jsonlContents(SESSION_ID, [
                envelope(sessionStartedEvent(SESSION_ID), 1, 'event_session_started'),
                envelope(
                    runEvent(SESSION_ID, 'run.failed', 'new run failed', {
                        runId: 'new_run',
                        command: 'wake',
                        state: 'failed',
                        reason: 'provider failed',
                        errorCode: 'unknown',
                    }),
                    2,
                    'event_new_run_failed',
                ),
            ]),
        });

        // Then: stale records are gone instead of merging with the new projection.
        const runs = await store.getRuns(SESSION_ID);
        expect(runs.map((run) => run.runId)).toEqual(['new_run']);
    });

    it('removes authoritative records and stores a diagnostic for corrupt JSONL', async () => {
        // Given: a valid derived index already exists for the session.
        const store = createFileSessionIndexStore({ indexPath: await indexPathFor('corrupt-rebuild') });
        await rebuildSessionIndexFromJsonl({
            store,
            sessionId: SESSION_ID,
            filePath: 'sessions/session_index_test.jsonl',
            contents: jsonlContents(SESSION_ID, [
                envelope(sessionStartedEvent(SESSION_ID), 1, 'event_session_started'),
            ]),
        });

        // When: a corrupt JSONL log is used as the new source of truth.
        const result = await rebuildSessionIndexFromJsonl({
            store,
            sessionId: SESSION_ID,
            filePath: 'sessions/session_index_test.jsonl',
            contents: `${serializeJsonlRecord(
                createJsonlSessionLogHeader({ sessionId: SESSION_ID, createdAt: CREATED_AT }),
            )}{not json}\n`,
        });

        // Then: stale authoritative records are removed and only diagnostics remain.
        await expect(store.getSession(SESSION_ID)).resolves.toBeNull();
        await expect(store.getRuns(SESSION_ID)).resolves.toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                kind: 'corrupt_jsonl',
                code: 'corrupt_line',
                lineNumber: 2,
                sessionId: SESSION_ID,
            }),
        ]);
        await expect(store.getDiagnostics(SESSION_ID)).resolves.toHaveLength(1);
    });

    it('returns run records in numeric sequence order', async () => {
        // Given: a JSONL log whose run event sequences would be misordered by string sorting.
        const store = createFileSessionIndexStore({ indexPath: await indexPathFor('run-sequence-order') });
        await rebuildSessionIndexFromJsonl({
            store,
            sessionId: SESSION_ID,
            filePath: 'sessions/session_index_test.jsonl',
            contents: jsonlContents(SESSION_ID, [
                envelope(sessionStartedEvent(SESSION_ID), 1, 'event_session_started'),
                envelope(runStateEvent(SESSION_ID, 'run_1'), 2, 'event_run_1'),
                envelope(runStateEvent(SESSION_ID, 'run_2'), 10, 'event_run_2'),
            ]),
        });

        // When: callers query runs from the derived index.
        const runs = await store.getRuns(SESSION_ID);

        // Then: the persisted index preserves numeric sequence ordering.
        expect(runs.map((run) => run.sequence)).toEqual([2, 10]);
        expect(runs.map((run) => run.runId)).toEqual(['run_1', 'run_2']);
    });

    it('serializes concurrent rebuilds for the same file-backed index', async () => {
        // Given: two sessions rebuilt into one derived index at the same time.
        const indexPath = await indexPathFor('concurrent-rebuilds');
        const store = createFileSessionIndexStore({ indexPath });
        const leftSessionId = 'session_index_left';
        const rightSessionId = 'session_index_right';

        // When: both rebuilds target the same index file concurrently.
        await Promise.all([
            rebuildSessionIndexFromJsonl({
                store,
                sessionId: leftSessionId,
                filePath: 'sessions/session_index_left.jsonl',
                contents: jsonlContents(leftSessionId, [
                    envelope(sessionStartedEvent(leftSessionId), 1, 'event_left_started'),
                    envelope(runStateEvent(leftSessionId, 'run_left'), 2, 'event_left_run'),
                ]),
            }),
            rebuildSessionIndexFromJsonl({
                store,
                sessionId: rightSessionId,
                filePath: 'sessions/session_index_right.jsonl',
                contents: jsonlContents(rightSessionId, [
                    envelope(sessionStartedEvent(rightSessionId), 1, 'event_right_started'),
                    envelope(runStateEvent(rightSessionId, 'run_right'), 2, 'event_right_run'),
                ]),
            }),
        ]);

        // Then: neither session's derived records are lost by read-modify-write races.
        await expect(store.getSession(leftSessionId)).resolves.toMatchObject({ sessionId: leftSessionId });
        await expect(store.getSession(rightSessionId)).resolves.toMatchObject({ sessionId: rightSessionId });
    });
});

async function expectQueryCoverage(store: SessionIndexStore, sessionId: string): Promise<void> {
    await expect(store.getSession(sessionId)).resolves.toMatchObject({
        sessionId,
        status: 'stopped',
        eventCount: 8,
        lastEventId: 'event_session_stopped',
    });
    await expect(store.listSessions()).resolves.toHaveLength(1);
    await expect(store.getRuns(sessionId)).resolves.toEqual([
        expect.objectContaining({
            runId: 'run_1',
            state: 'running',
            eventType: 'run.started',
        }),
    ]);
    await expect(store.getApprovals(sessionId)).resolves.toEqual([
        expect.objectContaining({
            approvalId: 'approval_patch',
            state: 'approved',
        }),
    ]);
    await expect(store.getTools(sessionId)).resolves.toEqual([
        expect.objectContaining({
            toolId: 'patch_call',
            status: 'failed',
            appliedFiles: ['a.txt'],
        }),
    ]);
    await expect(store.getProviderFailures(sessionId)).resolves.toEqual([
        expect.objectContaining({
            requestId: 'provider_request_task_prompt_1',
            error: expect.objectContaining({ code: 'unknown' }),
        }),
    ]);
}

async function indexPathFor(name: string): Promise<string> {
    const dir = join(TMP_ROOT, name);
    await mkdir(dir, { recursive: true });
    return join(dir, 'session-index.json');
}

function jsonlContents(sessionId: string, envelopes: readonly AgentEventEnvelope[]): string {
    const header = serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId, createdAt: CREATED_AT }));
    const records = envelopes.map((record) => serializeJsonlRecord(createJsonlSessionEventRecord(record)));
    return [header, ...records].join('');
}

function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: CREATED_AT,
        sessionId,
        message: 'mission-control session started',
    };
}

function runStateEvent(sessionId: string, runId: string): AgentEvent {
    return runEvent(sessionId, 'run.started', `${runId} started`, {
        runId,
        command: 'wake',
        state: 'running',
    });
}
