import { AsyncJobManager, RuntimeAgentRegistry } from '@mission-control/core';
import { describe, expect, it, vi } from 'vitest';
import type { CodingActionContext } from './interactive-chat-action-context';
import type { ChatOutput } from './interactive-chat-io';
import { KICK_CANCEL_REASON, runKickAction } from './interactive-kick-action';

const SELECTION = { providerID: 'local', modelID: 'local-echo' } as const;
const STALE = '2020-01-01T00:00:00.000Z';

function createOutput(): ChatOutput & { readonly lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        write: (text: string) => {
            lines.push(text);
        },
        controlsPrompt: true,
    };
}

function baseCoding(overrides: Partial<CodingActionContext> = {}): CodingActionContext {
    return {
        activeTurn: undefined,
        useTui: false,
        nextTurnId: () => 'turn_1',
        ...overrides,
    } as CodingActionContext;
}

describe('runKickAction', () => {
    it('reports when nothing is stalled', async () => {
        const output = createOutput();
        const result = await runKickAction(output, SELECTION, baseCoding());
        expect(result.activeTurn).toBeUndefined();
        expect(output.lines.join('')).toContain('No stalled running');
    });

    it('cancels stalled running jobs and marks matching agents aborted', async () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt({
            id: 'agent-1',
            displayName: 'deep',
            kind: 'sub',
            status: 'running',
            sessionId: 'sess-1',
        });
        registry.update('agent-1', { lastActivity: STALE, status: 'running' });

        const jobManager = new AsyncJobManager(1);
        let sawAbort = false;
        jobManager.startJob({
            sessionId: 'sess-1',
            agentId: 'agent-1',
            execute: async (signal) => {
                await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        sawAbort = true;
                        resolve();
                        return;
                    }
                    signal.addEventListener(
                        'abort',
                        () => {
                            sawAbort = true;
                            resolve();
                        },
                        { once: true },
                    );
                });
                return { status: 'failed', output: 'aborted' };
            },
        });

        const output = createOutput();
        await runKickAction(
            output,
            SELECTION,
            baseCoding({
                taskRuntimeServices: {
                    runtimeRegistry: registry,
                    jobManager,
                    lifecycleManager: {} as never,
                } as CodingActionContext['taskRuntimeServices'],
            }),
        );

        expect(output.lines.join('')).toContain('Kicking');
        expect(output.lines.join('')).toContain('agent deep');
        expect(registry.lookup('agent-1')?.status).toBe('aborted');
        await vi.waitFor(() => {
            expect(sawAbort).toBe(true);
        });
        const cancelled = jobManager.listJobs().filter((j) => j.cancellationReason === KICK_CANCEL_REASON);
        expect(cancelled.length).toBeGreaterThanOrEqual(1);
    });

    it('interrupts a stalled main turn and attempts resume', async () => {
        const output = createOutput();
        const interrupt = vi.fn();
        const done = Promise.resolve();
        const activeTurn = {
            done,
            interrupt,
            answerApproval: () => false,
            hasPendingApproval: () => false,
            setApprovalLevel: () => undefined,
            lastPacketAt: () => STALE,
        };

        await runKickAction(
            output,
            SELECTION,
            baseCoding({
                activeTurn: activeTurn as CodingActionContext['activeTurn'],
                sessionId: undefined,
                provider: undefined,
                workspaceRoot: undefined,
                sessionStore: undefined,
            }),
        );

        expect(interrupt).toHaveBeenCalledWith('force');
        expect(output.lines.join('')).toContain('Resetting foreground connection');
    });
});
