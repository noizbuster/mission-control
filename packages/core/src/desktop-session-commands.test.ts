import { defaultModelProviderSelection } from '@mission-control/config';
import { describe, expect, it } from 'vitest';
import { createDesktopSessionCommandService } from './desktop-session-commands.js';
import { commandRunCall, filePatchCall, fixedNow, readReplay } from './desktop-session-commands-test-support.js';
import { createDeterministicProvider } from './providers/deterministic-provider.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop session command service', () => {
    it('writes a submitted desktop prompt to the durable JSONL session log', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-prompt-'));
        const service = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot: dataDir,
            now: fixedNow,
            provider: createDeterministicProvider([{ kind: 'response_completed', content: 'desktop answer' }]),
        });

        try {
            // When
            const receipt = await service.submitPrompt({
                sessionId: 'session_desktop_prompt',
                prompt: 'summarize the repo from desktop',
                modelProviderSelection: defaultModelProviderSelection,
            });

            // Then
            const replay = await readReplay(dataDir, 'session_desktop_prompt');
            expect(receipt.status).toBe('completed');
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['prompt.admitted', 'prompt.promoted', 'run.completed']),
            );
            expect(replay.events.find((event) => event.type === 'prompt.admitted')?.message).toBe(
                'summarize the repo from desktop',
            );
            expect(
                replay.events.find((event) => event.type === 'model.call.completed')?.providerStreamChunk,
            ).toMatchObject({
                kind: 'response_completed',
                message: { content: 'desktop answer' },
            });
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('persists approval denial and leaves requested file and command effects untouched', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-deny-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-deny-workspace-'));
        const service = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot,
            now: fixedNow,
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'I can patch.' },
                filePatchCall('call_patch_denied', '.mission-control-denied.txt', 'denied write'),
                commandRunCall('call_test_denied'),
                { kind: 'response_completed', content: 'approval required' },
            ]),
        });

        try {
            // When
            await service.submitPrompt({
                sessionId: 'session_desktop_denied',
                prompt: 'deterministic patch and test',
                modelProviderSelection: defaultModelProviderSelection,
            });
            const receipt = await service.decideApproval({
                sessionId: 'session_desktop_denied',
                approvalId: 'approval_permission_call_patch_denied',
                state: 'denied',
                reason: 'manual desktop denial',
            });

            // Then
            const replay = await readReplay(dataDir, 'session_desktop_denied');
            await expect(stat(join(workspaceRoot, '.mission-control-denied.txt'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
            expect(receipt.status).toBe('blocked');
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['approval.requested', 'approval.updated', 'approval.blocked']),
            );
            expect(replay.events.map((event) => event.type)).not.toContain('file.diff.applied');
            expect(replay.events.map((event) => event.type)).not.toContain('command.completed');
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('replays approved desktop approvals with patch diff and command metadata after restart', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-allow-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-allow-workspace-'));
        const provider = createDeterministicProvider([
            { kind: 'text_delta', delta: 'I can patch and test.' },
            filePatchCall('call_patch_allowed', '.mission-control-allowed.txt', 'approved write'),
            commandRunCall('call_test_allowed'),
            { kind: 'response_completed', content: 'approval required' },
        ]);
        const firstProcess = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot,
            now: fixedNow,
            provider,
            commandExecutor: async () => ({
                exitCode: 0,
                signal: null,
                stdout: 'desktop test passed\n',
                stderr: '',
                timedOut: false,
                durationMs: 7,
            }),
        });

        try {
            await firstProcess.submitPrompt({
                sessionId: 'session_desktop_allowed',
                prompt: 'deterministic patch and test',
                modelProviderSelection: defaultModelProviderSelection,
            });
            const restartedProcess = createDesktopSessionCommandService({
                dataDir,
                workspaceRoot,
                now: fixedNow,
                provider,
                commandExecutor: async () => ({
                    exitCode: 0,
                    signal: null,
                    stdout: 'desktop test passed\n',
                    stderr: '',
                    timedOut: false,
                    durationMs: 7,
                }),
            });

            // When
            await restartedProcess.decideApproval({
                sessionId: 'session_desktop_allowed',
                approvalId: 'approval_permission_call_patch_allowed',
                state: 'approved',
                reason: 'desktop approved patch',
            });
            await restartedProcess.decideApproval({
                sessionId: 'session_desktop_allowed',
                approvalId: 'approval_permission_call_test_allowed',
                state: 'approved',
                reason: 'desktop approved test',
            });

            // Then
            const written = await readFile(join(workspaceRoot, '.mission-control-allowed.txt'), 'utf8');
            const replay = await readReplay(dataDir, 'session_desktop_allowed');
            expect(written).toBe('approved write\n');
            expect(replay.approvals).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        approvalId: 'approval_permission_call_patch_allowed',
                        state: 'approved',
                    }),
                    expect.objectContaining({
                        approvalId: 'approval_permission_call_test_allowed',
                        state: 'approved',
                    }),
                ]),
            );
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining([
                    'approval.resumed',
                    'file.diff.applied',
                    'command.completed',
                    'tool.completed',
                ]),
            );
            expect(replay.events.find((event) => event.type === 'command.completed')?.command).toMatchObject({
                command: ['pnpm', 'exec', 'vitest', 'run', 'packages/core/src/tools/command-run.fixture.test.ts'],
                status: 'completed',
                exitCode: 0,
            });
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
