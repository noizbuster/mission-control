import { AgentRuntime, createDeterministicProvider } from '@mission-control/core';
import type { WorkflowSpec } from '@mission-control/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInteractiveChatSession } from './interactive-chat';
import type { ChatActionResult } from './interactive-chat-action-result';
import type { CodingActionContext } from './interactive-chat-actions';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent';
import { createBufferedChatOutput, createScriptedChatInput } from './run-agent-chat-test-support';

const actionMocks = vi.hoisted(() => ({
    runChatAction: vi.fn(),
    startWorkflowTurn: vi.fn(),
}));

vi.mock('./interactive-chat-actions.js', async () => {
    const actual = await vi.importActual<typeof import('./interactive-chat-actions')>(
        './interactive-chat-actions.js',
    );
    return {
        ...actual,
        runChatAction: actionMocks.runChatAction,
        startWorkflowTurn: actionMocks.startWorkflowTurn,
    };
});

const selection = { providerID: 'local', modelID: 'local-echo' } as const;
type TurnWithOutcome = ActiveCodingAgentTurn & {
    readonly outcome: Promise<'completed' | 'interrupted'>;
};

beforeEach(() => {
    actionMocks.runChatAction.mockReset();
    actionMocks.startWorkflowTurn.mockReset();
    actionMocks.startWorkflowTurn.mockResolvedValue({ modelProviderSelection: selection });
});

describe('interactive self-invoked workflow chaining', () => {
    it('starts a queued workflow after its parent completes successfully', async () => {
        actionMocks.runChatAction.mockImplementationOnce(
            async (...args: Parameters<typeof import('./interactive-chat-actions')['runChatAction']>) => {
                queueDefaultWorkflow(args[6]);
                return resultWithTurn(settledTurn('completed'));
            },
        );
        const output = createBufferedChatOutput();

        await runInteractiveChatSession(new AgentRuntime(), {
            input: createScriptedChatInput(
                [
                    { type: 'line', value: 'start parent' },
                    { type: 'line', value: '/exit' },
                ],
                0,
            ),
            output: output.output,
            modelProviderSelection: selection,
            provider: createDeterministicProvider([]),
        });

        expect(actionMocks.startWorkflowTurn).toHaveBeenCalledOnce();
    });

    it('drops a queued workflow when the owner is externally interrupted', async () => {
        actionMocks.runChatAction.mockImplementationOnce(
            async (...args: Parameters<typeof import('./interactive-chat-actions')['runChatAction']>) => {
                queueDefaultWorkflow(args[6]);
                return resultWithTurn(settledTurn('interrupted'));
            },
        );
        const output = createBufferedChatOutput();

        await runInteractiveChatSession(new AgentRuntime(), {
            input: createScriptedChatInput(
                [
                    { type: 'line', value: 'start parent' },
                    { type: 'line', value: '/exit' },
                ],
                0,
            ),
            output: output.output,
            modelProviderSelection: selection,
            provider: createDeterministicProvider([]),
        });

        expect(actionMocks.startWorkflowTurn).not.toHaveBeenCalled();
    });

    it('drops a queued workflow after a local interrupt before a later turn completes', async () => {
        const interrupted = deferredTurn();
        actionMocks.runChatAction
            .mockImplementationOnce(
                async (...args: Parameters<typeof import('./interactive-chat-actions')['runChatAction']>) => {
                    queueDefaultWorkflow(args[6]);
                    return resultWithTurn(interrupted.turn);
                },
            )
            .mockResolvedValueOnce(resultWithTurn(settledTurn('completed')));
        const output = createBufferedChatOutput();

        await runInteractiveChatSession(new AgentRuntime(), {
            input: createScriptedChatInput(
                [
                    { type: 'line', value: 'start parent' },
                    { type: 'interrupt', source: 'ctrl-c' },
                    { type: 'line', value: 'unrelated turn' },
                    { type: 'line', value: '/exit' },
                ],
                0,
            ),
            output: output.output,
            modelProviderSelection: selection,
            provider: createDeterministicProvider([]),
        });

        expect(actionMocks.startWorkflowTurn).not.toHaveBeenCalled();
    });
});

function queueDefaultWorkflow(coding: CodingActionContext): void {
    const spec = coding.workflowRegistry?.lookup('default');
    if (spec === undefined) throw new Error('expected default workflow');
    coding.onWorkflowStarted?.(spec satisfies WorkflowSpec, 'queued child');
}

function resultWithTurn(activeTurn: ActiveCodingAgentTurn): ChatActionResult {
    return { modelProviderSelection: selection, activeTurn };
}

function settledTurn(outcome: 'completed' | 'interrupted'): TurnWithOutcome {
    return {
        done: Promise.resolve(),
        outcome: Promise.resolve(outcome),
        interrupt: () => undefined,
        answerApproval: () => false,
        hasPendingApproval: () => false,
        setApprovalLevel: () => undefined,
        lastPacketAt: () => new Date().toISOString(),
    };
}

function deferredTurn(): { readonly turn: TurnWithOutcome } {
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    const turn: TurnWithOutcome = {
        done,
        outcome: done.then(() => 'interrupted'),
        interrupt: () => resolveDone?.(),
        answerApproval: () => false,
        hasPendingApproval: () => false,
        setApprovalLevel: () => undefined,
        lastPacketAt: () => new Date().toISOString(),
    };
    return { turn };
}
