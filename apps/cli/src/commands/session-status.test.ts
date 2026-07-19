import { missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runSessionCommand } from './session';
import { SESSION_STATUS_FIXTURE_IDS, writeSessionStatusFixtureSessions } from './session-status-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session status command', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('prints approval awaiting details when a session id is provided', async () => {
        // Given: the SQL session projection has a pending approval wait.
        const dataDir = await useTempDataDir();
        await writeSessionStatusFixtureSessions(dataDir);

        try {
            // When: the status command targets that session.
            const output = await runSessionCommand(parseArgs(['session', 'status', SESSION_STATUS_FIXTURE_IDS.approval]));

            // Then: the stable line includes the reason and source ids in key order.
            expect(output).toMatchObject({ stderr: '', exitCode: 0 });
            expect(output.stdout).toBe(
                'session=session_status_approval status=awaiting reason=approval runId=run_approval toolCallId=patch_call updatedAt=2026-07-04T10:00:03.000Z',
            );
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('prints user_input awaiting details when a session id is provided', async () => {
        // Given: the SQL session projection has a pending user input wait.
        const dataDir = await useTempDataDir();
        await writeSessionStatusFixtureSessions(dataDir);

        try {
            // When: the status command targets that session.
            const output = await runSessionCommand(parseArgs(['session', 'status', SESSION_STATUS_FIXTURE_IDS.userInput]));

            // Then: reason=user_input is emitted only because the public status is awaiting.
            expect(output.stdout).toBe(
                'session=session_status_question status=awaiting reason=user_input runId=run_question toolCallId=ask_user_pending updatedAt=2026-07-04T10:00:04.000Z',
            );
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('prints subagent awaiting details when a session id is provided', async () => {
        // Given: the SQL session projection has a pending foreground subagent wait.
        const dataDir = await useTempDataDir();
        await writeSessionStatusFixtureSessions(dataDir);

        try {
            // When: the status command targets that session.
            const output = await runSessionCommand(parseArgs(['session', 'status', SESSION_STATUS_FIXTURE_IDS.subagent]));

            // Then: the child session id is visible without adding unrequested job metadata.
            expect(output.stdout).toBe(
                'session=session_status_child status=awaiting reason=subagent runId=run_subagent toolCallId=task_call childSessionId=session_status_child_worker updatedAt=2026-07-04T10:00:05.000Z',
            );
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('omits awaiting reason after the wait is cleared', async () => {
        // Given: the SQL session projection has a non-awaiting status after a prior wait cleared.
        const dataDir = await useTempDataDir();
        await writeSessionStatusFixtureSessions(dataDir);

        try {
            // When: the status command targets the cleared session.
            const output = await runSessionCommand(parseArgs(['session', 'status', SESSION_STATUS_FIXTURE_IDS.cleared]));

            // Then: no stale reason or source keys are emitted.
            expect(output.stdout).toBe(
                'session=session_status_cleared status=idle updatedAt=2026-07-04T10:00:06.000Z',
            );
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('throws the existing typed not-found error for a missing session', async () => {
        // Given: the SQL session projection has no matching session.
        const dataDir = await useTempDataDir();

        try {
            // When / Then: the command rejects with the same code used by existing session commands.
            await expect(runSessionCommand(parseArgs(['session', 'status', 'session_status_missing']))).rejects.toMatchObject({
                code: 'session_not_found',
                sessionId: 'session_status_missing',
            });
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('lists every known session in session-list sort order when no id is provided', async () => {
        // Given: four SQL projection rows with distinct updatedAt timestamps.
        const dataDir = await useTempDataDir();
        await writeSessionStatusFixtureSessions(dataDir);

        try {
            // When: the status command is run without an id.
            const output = await runSessionCommand(parseArgs(['session', 'status']));

            // Then: lines are newest first, matching the catalog list order.
            expect(output.stdout.split('\n')).toEqual([
                'session=session_status_cleared status=idle updatedAt=2026-07-04T10:00:06.000Z',
                'session=session_status_child status=awaiting reason=subagent runId=run_subagent toolCallId=task_call childSessionId=session_status_child_worker updatedAt=2026-07-04T10:00:05.000Z',
                'session=session_status_question status=awaiting reason=user_input runId=run_question toolCallId=ask_user_pending updatedAt=2026-07-04T10:00:04.000Z',
                'session=session_status_approval status=awaiting reason=approval runId=run_approval toolCallId=patch_call updatedAt=2026-07-04T10:00:03.000Z',
            ]);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('rejects --json because the first pass supports plain output only', () => {
        // Given / When / Then: --json is rejected at the session status argument boundary.
        expect(() => parseArgs(['session', 'status', '--json'])).toThrow('session status does not support --json');
    });
});

async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-session-status-'));
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}
