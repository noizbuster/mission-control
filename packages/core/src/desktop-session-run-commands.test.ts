import { defaultModelProviderSelection } from '@mission-control/config';
import { describe, expect, it } from 'vitest';
import { createDesktopSessionCommandService } from './desktop-session-commands.js';
import { fixedNow, readReplay } from './desktop-session-commands-test-support.js';
import { createDeterministicProvider } from './providers/deterministic-provider.js';
import type { ProviderAdapter, ProviderTurnRequest } from './providers/provider-turn-types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop session run commands', () => {
    it('records queue, resume, steer, and interrupt commands in the durable session log', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-run-commands-'));
        const sessionId = 'session_desktop_run_commands';
        const provider = createDeterministicProvider([{ kind: 'response_completed', content: 'desktop turn done' }]);
        const service = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot: dataDir,
            now: fixedNow,
            provider,
        });

        try {
            // When
            const queued = await service.queueFollowUp({
                sessionId,
                prompt: 'queued follow-up',
                modelProviderSelection: defaultModelProviderSelection,
            });
            const restarted = createDesktopSessionCommandService({
                dataDir,
                workspaceRoot: dataDir,
                now: fixedNow,
                provider,
            });
            const resumed = await restarted.resumeRun({ sessionId });
            const steered = await restarted.steerRun({
                sessionId,
                prompt: 'operator steering',
                modelProviderSelection: defaultModelProviderSelection,
            });
            const interrupted = await restarted.interruptRun({
                sessionId,
                reason: 'desktop operator stopped idle run',
            });

            // Then
            const replay = await readReplay(dataDir, sessionId);
            const commands = replay.events.flatMap((event) =>
                event.type === 'run.command.received' && event.run?.command !== undefined ? [event.run.command] : [],
            );
            expect(queued.status).toBe('queued');
            expect(resumed.status).toBe('completed');
            expect(steered.status).toBe('completed');
            expect(interrupted.status).toBe('idle');
            expect(commands).toEqual(expect.arrayContaining(['queue', 'resume', 'steer', 'wake', 'interrupt']));
            expect(replay.events.map((event) => event.message)).toEqual(
                expect.arrayContaining(['queued follow-up', 'operator steering', 'run command: interrupt']),
            );
            expect(
                replay.events.find(
                    (event) => event.type === 'run.command.received' && event.run?.command === 'interrupt',
                )?.run,
            ).toMatchObject({ reason: 'desktop operator stopped idle run', state: 'idle' });
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['prompt.admitted', 'prompt.promoted', 'run.completed']),
            );
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('resumes restarted desktop sessions with the persisted provider selection', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-run-provider-'));
        const sessionId = 'session_desktop_run_provider';
        const providerRequests: ProviderTurnRequest[] = [];
        const provider = recordingProvider(providerRequests);
        const originalSelection = {
            providerID: 'openai',
            modelID: 'gpt-4.1',
        };
        const firstProcess = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot: dataDir,
            now: fixedNow,
            provider,
            modelProviderSelection: defaultModelProviderSelection,
        });

        try {
            await firstProcess.queueFollowUp({
                sessionId,
                prompt: 'queued under openai',
                modelProviderSelection: originalSelection,
            });
            const restarted = createDesktopSessionCommandService({
                dataDir,
                workspaceRoot: dataDir,
                now: fixedNow,
                provider,
                modelProviderSelection: defaultModelProviderSelection,
            });

            // When
            const resumed = await restarted.resumeRun({ sessionId });

            // Then
            expect(resumed.status).toBe('completed');
            expect(providerRequests).toHaveLength(1);
            expect(providerRequests[0]).toMatchObject(originalSelection);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});

function recordingProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant',
                    content: 'desktop turn done',
                },
                finishReason: 'stop',
            };
        },
    };
}
