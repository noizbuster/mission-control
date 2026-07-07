import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
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
} from '../session-replay-coding-test-support.js';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './jsonl-session-records.js';
import { importLegacySessionCompatibilityWindow } from './session-import.js';
import { countRows, openMigratedTestDb } from './session-import-test-support.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TMP_ROOT = join(process.cwd(), 'tmp', 'session-import-projection-tests');

describe('legacy session import detailed projections', () => {
    afterEach(async () => {
        await rm(TMP_ROOT, { recursive: true, force: true });
    });

    it('projects detailed rows when importing legacy JSONL through the compatibility window', async () => {
        // Given: a legacy JSONL source contains coding-agent detail events but no helper-seeded projection rows.
        const sessionId = 'legacy_projection_session';
        const dataDir = join(TMP_ROOT, 'detailed-import', 'data');
        const sessionsDir = join(dataDir, 'sessions');
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(join(sessionsDir, `${sessionId}.jsonl`), detailedLegacyJsonl(sessionId), 'utf8');
        const runtime = await openMigratedTestDb();
        const client = runtime.client;

        try {
            // When: the production import compatibility window imports the JSONL source.
            const whenResult = await importLegacySessionCompatibilityWindow({
                ...runtime,
                dataDir,
                omoRoot: join(TMP_ROOT, 'detailed-import', '.omo'),
                now: () => '2026-07-01T00:00:00.000Z',
            });
            const messages = await client.execute(
                'SELECT message_id, role FROM session_messages WHERE session_id = ? ORDER BY seq',
                [sessionId],
            );
            const tools = await client.execute(
                'SELECT tool_call_id, name, status FROM tool_calls WHERE session_id = ? ORDER BY tool_call_id',
                [sessionId],
            );
            const approvals = await client.execute(
                'SELECT approval_id, status FROM approvals WHERE session_id = ? ORDER BY approval_id',
                [sessionId],
            );
            const failures = await client.execute(
                'SELECT event_id, request_id FROM provider_failures WHERE session_id = ? ORDER BY event_id',
                [sessionId],
            );

            // Then: imported events populate the same detailed SQLite projections append writes use.
            expect(whenResult).toMatchObject({
                importedEventCount: 10,
                importedSessionIndexRecordCount: 0,
                importedRunCount: 0,
                skippedSourceCount: 0,
                diagnostics: [],
            });
            await expect(countRows(client, 'session_events')).resolves.toBe(10);
            expect(messages.rows).toEqual([{ message_id: 'message_task_prompt_1', role: 'assistant' }]);
            expect(tools.rows).toEqual([{ tool_call_id: 'patch_call', name: 'file.patch', status: 'failed' }]);
            expect(approvals.rows).toEqual([{ approval_id: 'approval_patch', status: 'approved' }]);
            expect(failures.rows).toEqual([
                {
                    event_id: 'event_provider_failed',
                    request_id: 'provider_request_task_prompt_1',
                },
            ]);
        } finally {
            runtime.close();
        }
    });
});

function detailedLegacyJsonl(sessionId: string): string {
    const envelopes = [
        envelope(sessionStartedEvent(sessionId), 0, 'event_session_started'),
        envelope(
            runEvent(sessionId, 'run.started', 'run started', {
                runId: 'run_1',
                command: 'wake',
                state: 'running',
            }),
            1,
            'event_run_started',
        ),
        envelope(providerToolCallEvent(sessionId), 2, 'event_provider_tool_call'),
        envelope(providerCompletedEvent(sessionId, 'task_prompt_1', 'assistant summary'), 3, 'event_provider_message'),
        envelope(approvalEvent(sessionId, 'approval.requested', 'pending'), 4, 'event_approval_pending'),
        envelope(approvalEvent(sessionId, 'approval.updated', 'approved'), 5, 'event_approval_approved'),
        envelope(diffAppliedEvent(sessionId), 6, 'event_diff_applied'),
        envelope(toolFailedEvent(sessionId), 7, 'event_tool_failed'),
        envelope(providerFailedEvent(sessionId), 8, 'event_provider_failed'),
        envelope(sessionStoppedEvent(sessionId), 9, 'event_session_stopped'),
    ];
    return [
        serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId, createdAt: '2026-06-05T09:59:59.000Z' })),
        ...envelopes.map((item) => serializeJsonlRecord(createJsonlSessionEventRecord(item))),
    ].join('');
}

function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: '2026-06-05T09:59:59.000Z',
        sessionId,
        message: 'mission-control session started',
    };
}
