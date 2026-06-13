import { defaultModelProviderSelection } from '@mission-control/config';
import { describe, expect, it } from 'vitest';
import { fixedNow } from './desktop-session-commands-test-support.js';
import {
    approvalDecision,
    approvalOptions,
    approvalRequestedEvent,
    commandToolCall,
    completedCommandResult,
    countEvents,
    createDeferred,
    createMemoryApprovalStore,
    fileEditToolCall,
    filePatchToolCall,
    fileWriteToolCall,
    permissionRequestedEvent,
    providerToolCallEvent,
    runBlockedEvent,
    runFailedEvent,
} from './desktop-tool-approval-test-support.js';
import { settleDesktopApproval } from './desktop-tool-approvals.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('desktop tool approval settlement', () => {
    it('does not execute duplicate approval twice', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approval-race-workspace-'));
        const sessionId = 'session_desktop_approval_race';
        const toolCall = commandToolCall('call_duplicate_approval');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);
        let commandExecutions = 0;
        const firstExecutionStarted = createDeferred<void>();
        const releaseFirstExecution = createDeferred<void>();

        try {
            const first = settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_duplicate_approval', 'first click'),
                approvalOptions({
                    store,
                    sessionId,
                    workspaceRoot,
                    commandExecutor: async () => {
                        commandExecutions += 1;
                        firstExecutionStarted.resolve(undefined);
                        await releaseFirstExecution.promise;
                        return completedCommandResult();
                    },
                }),
            );
            await firstExecutionStarted.promise;
            const second = settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_duplicate_approval', 'second click'),
                approvalOptions({
                    store,
                    sessionId,
                    workspaceRoot,
                    commandExecutor: async () => {
                        commandExecutions += 1;
                        return completedCommandResult();
                    },
                }),
            );
            releaseFirstExecution.resolve(undefined);
            const statuses = await Promise.all([first, second]);

            expect(statuses).toEqual(expect.arrayContaining(['completed', 'idle']));
            expect(commandExecutions).toBe(1);
            expect(countEvents(store.events, 'command.completed')).toBe(1);
            expect(countEvents(store.events, 'tool.completed')).toBe(1);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('refuses approval decisions after run failure', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approval-failed-workspace-'));
        const sessionId = 'session_desktop_approval_failed';
        const toolCall = filePatchToolCall(
            'call_after_failure',
            '.mission-control-after-failure.txt',
            'must not write',
        );
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            runFailedEvent(sessionId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_after_failure', 'late click'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'file.diff.applied')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.mission-control-after-failure.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('returns idle for forged partial permission provenance that only matches permissionDecision.requestId', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approval-partial-provenance-'));
        const sessionId = 'session_desktop_partial_permission_provenance';
        const toolCall = filePatchToolCall('call_partial_permission_provenance', '.partial-provenance.txt', 'blocked');
        const forgedPermissionEvent = {
            ...permissionRequestedEvent(sessionId, toolCall),
            permissionRequest: {
                id: 'permission_forged_other_call',
                action: toolCall.toolName,
                reason: `approve ${toolCall.toolName}`,
            },
        };
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            forgedPermissionEvent,
            approvalRequestedEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(
                    sessionId,
                    'approval_permission_call_partial_permission_provenance',
                    'forged partial provenance',
                ),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'approval.updated')).toBe(0);
            expect(countEvents(store.events, 'file.diff.applied')).toBe(0);
            expect(countEvents(store.events, 'tool.completed')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.partial-provenance.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('applies approved file mutations once and reuses the shared diff event surface', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-file-mutations-'));
        const sessionId = 'session_desktop_file_mutations';
        const editPath = '.mission-control-edit.txt';
        const writePath = 'nested/.mission-control-write.txt';
        await writeFile(join(workspaceRoot, editPath), 'before unique after\n', 'utf8');
        await execFileAsync('git', ['init'], { cwd: workspaceRoot });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
        await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceRoot });
        await execFileAsync('git', ['add', editPath], { cwd: workspaceRoot });
        await execFileAsync('git', ['commit', '-m', `add ${editPath}`], { cwd: workspaceRoot });
        const editCall = fileEditToolCall('call_file_edit', editPath, 'unique', 'changed');
        const writeCall = fileWriteToolCall('call_file_write', writePath, 'created\n', true);
        const patchCall = filePatchToolCall(
            'call_duplicate_patch',
            '.mission-control-duplicate-patch.txt',
            'one write',
        );

        try {
            const editStatus = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_file_edit', 'approve exact edit'),
                approvalOptions({
                    store: createMemoryApprovalStore([
                        providerToolCallEvent(sessionId, editCall),
                        permissionRequestedEvent(sessionId, editCall),
                        approvalRequestedEvent(sessionId, editCall),
                        runBlockedEvent(sessionId, editCall.toolCallId),
                    ]),
                    sessionId,
                    workspaceRoot,
                }),
            );
            const writeStatus = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_file_write', 'approve full write'),
                approvalOptions({
                    store: createMemoryApprovalStore([
                        providerToolCallEvent(sessionId, writeCall),
                        permissionRequestedEvent(sessionId, writeCall),
                        approvalRequestedEvent(sessionId, writeCall),
                        runBlockedEvent(sessionId, writeCall.toolCallId),
                    ]),
                    sessionId,
                    workspaceRoot,
                }),
            );
            const patchStore = createMemoryApprovalStore([
                providerToolCallEvent(sessionId, patchCall),
                permissionRequestedEvent(sessionId, patchCall),
                approvalRequestedEvent(sessionId, patchCall),
                runBlockedEvent(sessionId, patchCall.toolCallId),
            ]);
            const patchStatuses = await Promise.all([
                settleDesktopApproval(
                    approvalDecision(sessionId, 'approval_permission_call_duplicate_patch', 'first click'),
                    approvalOptions({ store: patchStore, sessionId, workspaceRoot }),
                ),
                settleDesktopApproval(
                    approvalDecision(sessionId, 'approval_permission_call_duplicate_patch', 'second click'),
                    approvalOptions({ store: patchStore, sessionId, workspaceRoot }),
                ),
            ]);

            expect(editStatus).toBe('completed');
            expect(writeStatus).toBe('completed');
            expect(patchStatuses).toEqual(expect.arrayContaining(['completed', 'idle']));
            expect(await readFile(join(workspaceRoot, editPath), 'utf8')).toBe('before changed after\n');
            expect(await readFile(join(workspaceRoot, writePath), 'utf8')).toBe('created\n');
            expect(await readFile(join(workspaceRoot, '.mission-control-duplicate-patch.txt'), 'utf8')).toBe(
                'one write\n',
            );
            expect(countEvents(patchStore.events, 'file.diff.applied')).toBe(1);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('ignores resume requests when no approval is pending', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-resume-idle-'));
        const sessionId = 'session_desktop_resume_idle';
        const store = createMemoryApprovalStore([]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_missing', 'stale resume'),
                {
                    store,
                    sessionId,
                    workspaceRoot: dataDir,
                    modelProviderSelection: defaultModelProviderSelection,
                    now: fixedNow,
                },
            );

            expect(status).toBe('idle');
            expect(store.events).toHaveLength(0);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});
