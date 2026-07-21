import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '@mission-control/cli/args';
import { runSessionCommand } from '@mission-control/cli/commands/session';
import { SqlAgentJobMirror } from '../packages/core/src/agents/agent-job-sql-mirror';
import { openLocalLibsqlDb } from '../packages/core/src/db/local-libsql-db';
import { localSessionDbPath, parseSessionArchive } from '@mission-control/core';
import { SqlSessionInputDelivery } from '../packages/core/src/runtime/session-input-delivery';
import {
    appendNativeEvents,
    approvalEvent,
    approvalResumedEvent,
    metadataEvent,
    providerCompletedEvent,
    providerFailedEvent,
    providerToolCallEvent,
    readDetailRows,
    readJobRows,
    readStatusRows,
    readWaitRows,
    runEvent,
    sessionStartedEvent,
    sessionStoppedEvent,
    tempDataDir,
    toolCompletedEvent,
    writeDbRowsArtifact,
} from './coding-agent-session-store-e2e-support';
import { startForegroundChildWait } from './coding-agent-session-store-e2e-task-support';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const tempDirs: string[] = [];

describe('coding-agent SQLite session store e2e hardening', () => {
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('preserves production append await resume list archive export in one temp data dir', async () => {
        // Given: one temp data dir with a native parent session.
        const dataDir = await tempDataDir(tempDirs);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const parentSessionId = 'session_e2e_parent';
        await appendNativeEvents(dataDir, parentSessionId, [
            sessionStartedEvent(parentSessionId),
            metadataEvent(parentSessionId),
            runEvent(parentSessionId, 'run.started', 'running', {
                command: 'run',
                state: 'running',
                runId: 'run_parent',
            }),
            providerToolCallEvent(parentSessionId),
            providerCompletedEvent(parentSessionId),
            approvalEvent(parentSessionId, 'approval.requested', 'pending'),
            runEvent(parentSessionId, 'run.blocked', 'waiting for approval: file.patch', {
                command: 'run',
                state: 'blocked_on_approval',
                runId: 'run_parent',
                reason: 'waiting for approval: file.patch',
                errorCode: 'tool_failed',
                toolCallId: 'patch_call',
            }),
        ]);

        // When: public CLI paths list the waits, then the parent resumes and exports.
        const blockedListOutput = (await runSessionCommand(parseArgs(['session', 'list']))).stdout;
        await appendNativeEvents(dataDir, parentSessionId, [
            runEvent(parentSessionId, 'run.command.received', 'resume received', {
                command: 'resume',
                state: 'blocked_on_approval',
                runId: 'run_parent',
                toolCallId: 'patch_call',
            }),
            approvalEvent(parentSessionId, 'approval.updated', 'approved'),
            approvalResumedEvent(parentSessionId),
            toolCompletedEvent(parentSessionId),
            providerFailedEvent(parentSessionId),
            runEvent(parentSessionId, 'run.completed', 'resume completed', {
                command: 'resume',
                state: 'completed',
                runId: 'run_parent',
            }),
            sessionStoppedEvent(parentSessionId, 2),
        ]);
        const finalShow = JSON.parse((await runSessionCommand(parseArgs(['session', 'show', parentSessionId]))).stdout);
        const archivePath = join(dataDir, 'exports', 'parent.mctrl-session.json');
        await runSessionCommand(parseArgs(['session', 'export', parentSessionId, archivePath]));
        const archive = parseSessionArchive(await readFile(archivePath, 'utf8'));
        const runtime = await openLocalLibsqlDb({ url: `file:${localSessionDbPath(dataDir)}` });
        try {
            const statusRows = await readStatusRows(runtime);
            const waitRows = await readWaitRows(runtime);
            const detailRows = await readDetailRows(runtime, parentSessionId);
            const dbRowsArtifactPath = process.env.MCTRL_SESSION_STORE_E2E_DB_ROWS_PATH;
            if (dbRowsArtifactPath !== undefined) {
                await writeDbRowsArtifact(dbRowsArtifactPath, {
                    capturedAt: '2026-07-06T00:00:10.000Z',
                    statusRows,
                    waitRows,
                    detailRows,
                });
            }

            // Then: public output, DB rows, and archive export agree.
            expect(blockedListOutput).toContain(
                'session_e2e_parent\tstatus=awaiting approval (approval=approval_patch,run=run_parent,tool=patch_call)',
            );
            expect(finalShow).toMatchObject({
                sessionId: parentSessionId,
                status: 'stopped',
                statusText: 'stopped',
                eventCount: 14,
            });
            expect(archive.manifest.sessionId).toBe(parentSessionId);
            expect(archive.eventsJsonl).toContain('approval.resumed');
            expect(statusRows).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        session_id: parentSessionId,
                        status: 'stopped',
                    }),
                ]),
            );
            expect(waitRows).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ session_id: parentSessionId, reason: 'approval', status: 'resolved' }),
                ]),
            );
            expect(detailRows.messages).toEqual([{ message_id: 'message_parent', role: 'assistant' }]);
            expect(detailRows.tools).toEqual([{ tool_call_id: 'patch_call', name: 'file.patch', status: 'completed' }]);
            expect(detailRows.approvals).toEqual([{ approval_id: 'approval_patch', status: 'approved' }]);
            expect(detailRows.failures).toEqual([
                { event_id: `${parentSessionId}_11_model_call_failed`, request_id: 'request_parent' },
            ]);
        } finally {
            runtime.close();
        }
    });

    it('projects production user input and foreground subagent waits through public Mission Control DB reads', async () => {
        // Given: real session rows plus production wait adapters sharing one data-dir mission-control.db.
        const dataDir = await tempDataDir(tempDirs);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const userSessionId = 'session_e2e_user_input';
        const parentSessionId = 'session_e2e_subagent_parent';
        const childSessionId = 'session_e2e_subagent_child';
        await appendNativeEvents(dataDir, userSessionId, [sessionStartedEvent(userSessionId)]);
        await appendNativeEvents(dataDir, parentSessionId, [sessionStartedEvent(parentSessionId)]);

        const delivery = await SqlSessionInputDelivery.open({ dataDir });
        await delivery.admitInput(userSessionId, { inputId: 'operator_prompt', prompt: 'Approve plan?' }, 'queue', {
            blocking: true,
        });
        delivery.close();

        const runtime = await openLocalLibsqlDb({ url: `file:${localSessionDbPath(dataDir)}` });
        const mirror = await SqlAgentJobMirror.create(runtime);
        const foreground = await startForegroundChildWait({ parentSessionId, childSessionId, mirror });

        try {
            // When: CLI/public reads inspect both pending waits before the foreground child resolves.
            const blockedListOutput = (await runSessionCommand(parseArgs(['session', 'list']))).stdout;
            const userShow = JSON.parse(
                (await runSessionCommand(parseArgs(['session', 'show', userSessionId]))).stdout,
            );
            const subagentShow = JSON.parse(
                (await runSessionCommand(parseArgs(['session', 'show', parentSessionId]))).stdout,
            );
            const statusRows = await readStatusRows(runtime);
            const waitRows = await readWaitRows(runtime);
            const jobRows = await readJobRows(runtime);
            const dbRowsArtifactPath = process.env.MCTRL_SESSION_STORE_E2E_DB_ROWS_PATH;
            if (dbRowsArtifactPath !== undefined) {
                await writeDbRowsArtifact(dbRowsArtifactPath, {
                    capturedAt: '2026-07-06T00:00:20.000Z',
                    statusRows,
                    waitRows,
                    publicListOutput: blockedListOutput,
                    publicUserShow: userShow,
                    publicSubagentShow: subagentShow,
                    jobRows,
                });
            }

            // Then: public session-list/read projections include user_input and subagent awaiting metadata.
            expect(blockedListOutput).toContain(
                'session_e2e_user_input\tstatus=awaiting user input (input=operator_prompt)',
            );
            expect(blockedListOutput).toContain(
                'session_e2e_subagent_parent\tstatus=awaiting subagent (job=session_e2e_subagent_child,child=session_e2e_subagent_child)',
            );
            expect(userShow).toMatchObject({
                sessionId: userSessionId,
                status: 'awaiting',
                statusText: 'awaiting user input (input=operator_prompt)',
                awaiting: { reason: 'user_input', source: { inputId: 'operator_prompt' } },
            });
            expect(userShow.awaiting.source.runId).toBeUndefined();
            expect(subagentShow).toMatchObject({
                sessionId: parentSessionId,
                status: 'awaiting',
                statusText: 'awaiting subagent (job=session_e2e_subagent_child,child=session_e2e_subagent_child)',
                awaiting: {
                    reason: 'subagent',
                    source: { jobId: childSessionId, childSessionId },
                },
            });
            expect(statusRows).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        session_id: userSessionId,
                        status: 'awaiting',
                        awaiting_reason: 'user_input',
                    }),
                    expect.objectContaining({
                        session_id: parentSessionId,
                        status: 'awaiting',
                        awaiting_reason: 'subagent',
                    }),
                ]),
            );
            expect(waitRows).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ session_id: userSessionId, reason: 'user_input', status: 'pending' }),
                    expect.objectContaining({ session_id: parentSessionId, reason: 'subagent', status: 'pending' }),
                ]),
            );
            expect(jobRows).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ job_id: childSessionId, parent_session_id: parentSessionId }),
                ]),
            );
        } finally {
            foreground.release();
            await foreground.done;
            await mirror.flush();
            runtime.close();
        }
    });
});
