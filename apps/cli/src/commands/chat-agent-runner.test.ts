import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { AgentRuntime } from '@mission-control/core';
import { ChatStore } from './chat-store.js';
import {
    startChatAgentRunner,
    type AgentRunnerHandle,
    type DispatchActionContext,
} from './chat-agent-runner.js';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';
import type { ChatLineAction } from './chat-commands.js';
import type { ApprovalLevel } from './approval-level.js';

const SELECTION: ModelProviderSelection = { providerID: 'test', modelID: 'echo' };

type ControllableTurn = {
    readonly turn: ActiveCodingAgentTurn;
    readonly resolve: () => void;
    readonly interruptMode: () => string | undefined;
    readonly setPendingApproval: (value: boolean) => void;
    readonly answered: () => readonly string[];
};

function createControllableTurn(opts?: { readonly pendingApproval?: boolean }): ControllableTurn {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    let interruptCalled: string | undefined;
    let pendingApproval = opts?.pendingApproval ?? false;
    const answeredList: string[] = [];

    const turnObj: ActiveCodingAgentTurn = {
        done,
        interrupt: (mode?: 'soft' | 'force'): void => {
            interruptCalled = mode ?? 'soft';
            if (mode === 'force') {
                resolveDone();
            }
        },
        answerApproval: (line: string): boolean => {
            answeredList.push(line);
            if (pendingApproval) {
                pendingApproval = false;
                return true;
            }
            return false;
        },
        hasPendingApproval: (): boolean => pendingApproval,
        setApprovalLevel: (_level: ApprovalLevel): void => {},
    };

    return {
        turn: turnObj,
        resolve: resolveDone,
        interruptMode: () => interruptCalled,
        setPendingApproval: (value: boolean) => {
            pendingApproval = value;
        },
        answered: () => [...answeredList],
    };
}

type TestRunnerConfig = {
    readonly dispatchAction?: (
        action: ChatLineAction,
        context: DispatchActionContext,
    ) => Promise<ChatActionResult>;
    readonly parseLine?: (value: string) => ChatLineAction;
    readonly cleanup?: () => Promise<void>;
    readonly initialApprovalLevel?: ApprovalLevel;
};

type TestRunner = {
    readonly handle: AgentRunnerHandle;
    readonly store: ChatStore;
};

const handlesToCleanup: AgentRunnerHandle[] = [];

function createTestRunner(config?: TestRunnerConfig): TestRunner {
    const store = new ChatStore();
    const runtime = new AgentRuntime({ modelProviderSelection: SELECTION });

    const dispatchAction =
        config?.dispatchAction ??
        (async (_action: ChatLineAction): Promise<ChatActionResult> => actionResult(SELECTION));

    const parseLine =
        config?.parseLine ??
        ((value: string): ChatLineAction => {
            const trimmed = value.trim();
            if (trimmed === '/exit') return { kind: 'exit' };
            if (trimmed.length === 0) return { kind: 'empty' };
            return { kind: 'prompt', prompt: value };
        });

    const cleanup = config?.cleanup ?? (async (): Promise<void> => {});

    const handle = startChatAgentRunner({
        runtime,
        store,
        modelProviderSelection: SELECTION,
        dispatchAction,
        parseLine,
        appendHistory: async () => {},
        cleanup,
        ...(config?.initialApprovalLevel !== undefined
            ? { initialApprovalLevel: config.initialApprovalLevel }
            : {}),
    });

    handlesToCleanup.push(handle);
    return { handle, store };
}

async function flush(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await vi.advanceTimersByTimeAsync(0);
    }
}

async function advanceYield(): Promise<void> {
    await vi.advanceTimersByTimeAsync(25);
}

describe('chat-agent-runner', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(async () => {
        while (handlesToCleanup.length > 0) {
            const h = handlesToCleanup.pop();
            if (h !== undefined) {
                try {
                    await h.stop();
                } catch {
                    // ignore cleanup errors
                }
            }
        }
        vi.useRealTimers();
    });

    // 1. idle -> running -> idle
    it('transitions idle to running to idle on turn completion', async () => {
        const turn = createControllableTurn();
        const dispatchAction = async (action: ChatLineAction): Promise<ChatActionResult> => {
            if (action.kind === 'prompt') return actionResult(SELECTION, turn.turn);
            return actionResult(SELECTION);
        };
        const { handle } = createTestRunner({ dispatchAction });

        expect(handle.state()).toBe('idle');

        handle.submit('hello');
        await flush();
        expect(handle.state()).toBe('running');

        turn.resolve();
        await flush();
        expect(handle.state()).toBe('idle');
    });

    // 2. Approval routing (G2/G3)
    it('routes approval answers to the active turn, not the parser (G3)', async () => {
        const turn = createControllableTurn({ pendingApproval: true });
        let dispatchCount = 0;
        const dispatchAction = async (action: ChatLineAction): Promise<ChatActionResult> => {
            dispatchCount++;
            if (action.kind === 'prompt') return actionResult(SELECTION, turn.turn);
            return actionResult(SELECTION);
        };
        const { handle } = createTestRunner({ dispatchAction });

        handle.submit('do work');
        await flush();
        expect(handle.state()).toBe('awaiting-approval');

        handle.submit('once');
        await advanceYield();
        await flush();

        expect(turn.answered()).toContain('once');
        expect(dispatchCount).toBe(1);
    });

    // 3. Interrupt -> await done (G4)
    it('awaits turn done on interrupt before proceeding (G4)', async () => {
        const turn = createControllableTurn();
        const dispatchAction = async (action: ChatLineAction): Promise<ChatActionResult> => {
            if (action.kind === 'prompt') return actionResult(SELECTION, turn.turn);
            return actionResult(SELECTION);
        };
        const { handle } = createTestRunner({ dispatchAction });

        handle.submit('work');
        await flush();
        expect(handle.state()).toBe('running');

        handle.interrupt('ctrl-c');
        await advanceYield();
        await flush();

        expect(turn.interruptMode()).toBe('soft');
        expect(handle.state()).toBe('running');

        turn.resolve();
        await flush();
        expect(handle.state()).toBe('idle');
    });

    // 4. Double Ctrl+C -> exit (G9)
    it('exits on two consecutive Ctrl+C presses while idle (G9)', async () => {
        const { handle } = createTestRunner();

        expect(handle.state()).toBe('idle');

        handle.interrupt('ctrl-c');
        await flush();
        expect(handle.state()).toBe('idle');

        handle.interrupt('ctrl-c');
        await flush();
        expect(handle.state()).toBe('exiting');
    });

    // 5. ESC interrupt while idle -> NO exit (G9)
    it('never exits on ESC interrupts (G9)', async () => {
        const { handle } = createTestRunner();

        handle.interrupt('esc');
        await flush();
        expect(handle.state()).toBe('idle');

        handle.interrupt('esc');
        await flush();
        expect(handle.state()).toBe('idle');

        handle.interrupt('esc');
        await flush();
        expect(handle.state()).toBe('idle');
    });

    // 6. interruptedPartialInput -> NO exit (G9)
    it('does not exit when Ctrl+C has interruptedPartialInput even with pendingInterrupt (G9)', async () => {
        const { handle, store } = createTestRunner();

        handle.interrupt('ctrl-c');
        await flush();

        store.enqueueEvent({
            type: 'interrupt',
            source: 'ctrl-c',
            interruptedPartialInput: true,
        });
        await flush();

        expect(handle.state()).toBe('idle');
    });

    // 7. /exit -> stopActiveTurn (G10)
    it('force-stops the active turn on /exit (G10)', async () => {
        const turn = createControllableTurn();
        const dispatchAction = async (action: ChatLineAction): Promise<ChatActionResult> => {
            if (action.kind === 'prompt') return actionResult(SELECTION, turn.turn);
            return actionResult(SELECTION);
        };
        const { handle } = createTestRunner({ dispatchAction });

        handle.submit('work');
        await flush();
        expect(handle.state()).toBe('running');

        handle.submit('/exit');
        await advanceYield();
        await flush();

        expect(turn.interruptMode()).toBe('force');
        expect(handle.state()).toBe('exiting');
    });

    // 8. Cleanup on exception (G10)
    it('runs cleanup when the loop exits via exception (G10)', async () => {
        let cleanupCalled = false;
        const { handle } = createTestRunner({
            parseLine: (): ChatLineAction => {
                throw new Error('parse boom');
            },
            cleanup: async () => {
                cleanupCalled = true;
            },
        });

        handle.submit('trigger');
        await flush();
        await handle.stop();

        expect(cleanupCalled).toBe(true);
    });

    // 9. Queue during running (G8)
    it('passes activeTurn to dispatch when input arrives during running (G8)', async () => {
        const turnA = createControllableTurn();
        const contexts: DispatchActionContext[] = [];
        const dispatchAction = async (
            action: ChatLineAction,
            context: DispatchActionContext,
        ): Promise<ChatActionResult> => {
            contexts.push(context);
            if (action.kind === 'prompt') {
                return actionResult(SELECTION, context.activeTurn ?? turnA.turn);
            }
            return actionResult(SELECTION);
        };
        const { handle, store } = createTestRunner({ dispatchAction });

        handle.submit('first');
        await flush();
        expect(handle.state()).toBe('running');

        store.enqueueEvent({ type: 'line', value: 'second' });
        await advanceYield();
        await flush();

        expect(contexts.length).toBe(2);
        expect(contexts[1]?.activeTurn).toBe(turnA.turn);
        expect(handle.state()).toBe('running');
    });

    // 10. Concurrent submit blocked (G1)
    it('does not create a second turn while one is running (G1)', async () => {
        const turnA = createControllableTurn();
        const dispatchAction = async (
            action: ChatLineAction,
            context: DispatchActionContext,
        ): Promise<ChatActionResult> => {
            if (action.kind === 'prompt') {
                return actionResult(SELECTION, context.activeTurn ?? turnA.turn);
            }
            return actionResult(SELECTION);
        };
        const { handle } = createTestRunner({ dispatchAction });

        handle.submit('first');
        await flush();

        handle.submit('second');
        await advanceYield();
        await flush();

        expect(handle.state()).toBe('running');
        expect(turnA.interruptMode()).toBeUndefined();
    });

    // 11. 25ms yield: completion wins over queued input (G1)
    it('completion wins over queued input due to 25ms yield (G1)', async () => {
        const turnA = createControllableTurn();
        const contexts: DispatchActionContext[] = [];
        const dispatchAction = async (
            action: ChatLineAction,
            context: DispatchActionContext,
        ): Promise<ChatActionResult> => {
            contexts.push(context);
            if (action.kind === 'prompt' && context.activeTurn === undefined) {
                return actionResult(SELECTION, turnA.turn);
            }
            return actionResult(SELECTION);
        };
        const { handle, store } = createTestRunner({ dispatchAction });

        handle.submit('first');
        await flush();
        expect(handle.state()).toBe('running');

        store.enqueueEvent({ type: 'line', value: 'second' });

        turnA.resolve();
        await flush();

        expect(turnA.interruptMode()).toBeUndefined();
        expect(handle.state()).toBe('idle');

        await advanceYield();
        await flush();

        expect(contexts.length).toBe(2);
        expect(contexts[1]?.activeTurn).toBeUndefined();
    });

    // 12. Empty prompt skipped
    it('skips empty prompts without dispatching', async () => {
        let dispatchCount = 0;
        const dispatchAction = async (): Promise<ChatActionResult> => {
            dispatchCount++;
            return actionResult(SELECTION);
        };
        const { handle } = createTestRunner({ dispatchAction });

        handle.submit('   ');
        await flush();

        expect(dispatchCount).toBe(0);
        expect(handle.state()).toBe('idle');
    });

    // 13. ESC then Ctrl+C does not count as double press
    it('treats Ctrl+C after ESC as the first press, not the second (G9)', async () => {
        const { handle } = createTestRunner();

        handle.interrupt('esc');
        await flush();

        handle.interrupt('ctrl-c');
        await flush();
        expect(handle.state()).toBe('idle');

        handle.interrupt('ctrl-c');
        await flush();
        expect(handle.state()).toBe('exiting');
    });

    // 14. Interrupt during running resets pendingInterrupt
    it('clears pendingInterrupt when interrupting an active turn', async () => {
        const turn = createControllableTurn();
        const dispatchAction = async (action: ChatLineAction): Promise<ChatActionResult> => {
            if (action.kind === 'prompt') return actionResult(SELECTION, turn.turn);
            return actionResult(SELECTION);
        };
        const { handle } = createTestRunner({ dispatchAction });

        handle.interrupt('ctrl-c');
        await flush();

        handle.submit('work');
        await flush();
        expect(handle.state()).toBe('running');

        handle.interrupt('ctrl-c');
        await advanceYield();
        await flush();

        expect(turn.interruptMode()).toBe('soft');

        turn.resolve();
        await flush();
        expect(handle.state()).toBe('idle');

        handle.interrupt('ctrl-c');
        await flush();
        expect(handle.state()).toBe('idle');
    });
});
