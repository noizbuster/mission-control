// allow: SIZE_OK — indivisible state machine; every transition mutates the same
// closure variables (activeTurn, exiting, pendingInterrupt, currentModelProviderSelection).
// Extracting sub-units would require passing 5+ mutable refs as parameters.
/**
 * Background agent runner state machine.
 *
 * Replaces the imperative `for(;;)` loop in `interactive-chat.ts` with an
 * async background function that consumes `ChatInputEvent`s from the
 * `ChatStore` event queue and dispatches them through the action pipeline.
 *
 * Preserves the 10 sequential guarantees (G1-G10) defined in
 * `.omo/plans/reactive-tui-architecture.md`:
 *
 * G1  Single in-flight turn per session.
 * G2  Tool approval happens-before tool execution.
 * G3  Approval answers route to active turn, not parse.
 * G4  Interrupt -> await turn done before proceeding.
 * G5  Session events appended durably before receipt settles.
 * G6  Provider streaming renders token-by-token (16ms coalesced by store).
 * G7  Model/approval persistence reflects last user choice (applied after action).
 * G8  Queue/steer enter through coordinator, not new turn.
 * G9  Exit requires two consecutive Ctrl+C while idle (ESC never exits).
 * G10 Cleanup runs even on exception.
 */

import type { AgentRuntime, PermissionSession, ProviderAdapter } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { closeTreeSitterClient } from '../components/markdown/highlight.js';
import type { ApprovalLevel } from './approval-level.js';
import { approvalLevelRules } from './approval-level.js';
import { type ChatLineAction, type ChatLineOptions, parseChatLine } from './chat-commands.js';
import type { ChatStore } from './chat-store.js';
import { appendInputHistoryEntry } from './input-history-store.js';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ChatInputEvent, ChatOutput } from './interactive-chat-io.js';
import { maxChatPromptLength } from './interactive-chat-io.js';
import type { ModelChoice } from './interactive-chat-model.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';

const YIELD_BEFORE_READ_MS = 25;

export type AgentRunnerState = 'idle' | 'running' | 'awaiting-approval' | 'exiting';

export type DispatchActionContext = {
    readonly activeTurn: ActiveCodingAgentTurn | undefined;
};

export type AgentRunnerOptions = {
    readonly runtime: AgentRuntime;
    readonly store: ChatStore;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly workspaceRoot?: string;
    readonly provider?: ProviderAdapter;
    readonly resolveProviderForSelection?: (selection: ModelProviderSelection) => ProviderAdapter;
    readonly sessionId?: string;
    readonly initialApprovalLevel?: ApprovalLevel;
    readonly permissionSession?: PermissionSession;
    readonly knownSkillNames?: ReadonlySet<string>;
    readonly knownWorkflowNames?: ReadonlySet<string>;
    readonly modelChoices?: readonly ModelChoice[];
    readonly dispatchAction?: (action: ChatLineAction, context: DispatchActionContext) => Promise<ChatActionResult>;
    readonly parseLine?: (value: string) => ChatLineAction;
    readonly appendHistory?: (value: string) => Promise<void>;
    readonly cleanup?: () => Promise<void>;
};

export type AgentRunnerHandle = {
    readonly state: () => AgentRunnerState;
    readonly submit: (prompt: string) => void;
    readonly interrupt: (source: 'ctrl-c' | 'esc') => void;
    readonly stop: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Deduplicating event pump over `store.waitForEvent()`.
 *
 * Mirrors the `ChatInputPump` pattern from `interactive-chat-loop-support.ts`:
 * if a read is already pending, subsequent `read()` calls return the same
 * promise instead of pushing a new waiter into the store. This prevents
 * orphaned waiters when `Promise.race` abandons a read after the active
 * turn completes (G1).
 */
function createStoreEventPump(store: ChatStore): { readonly read: () => Promise<ChatInputEvent> } {
    let pending: Promise<ChatInputEvent> | undefined;
    return {
        read(): Promise<ChatInputEvent> {
            if (pending === undefined) {
                pending = store.waitForEvent().finally(() => {
                    pending = undefined;
                });
            }
            return pending;
        },
    };
}

/**
 * Adapts a `ChatStore` to the `ChatOutput` interface. The store handles the
 * 16ms coalescing on `emitOutput` (G6) and owns all UI state mutations.
 */
export function createStoreChatOutput(store: ChatStore): ChatOutput {
    return {
        write: (text: string) => store.emitOutput(text),
        getOutput: () => store.getOutput(),
        setAgentStatus: (text: string) => store.setAgentStatus(text),
        clearAgentStatus: () => store.clearAgentStatus(),
        isShowThinking: () => store.getSnapshot().showThinking,
        isToolOutputExpanded: () => store.getSnapshot().toolOutputExpanded,
        showApproval: (toolName: string, action: string) => store.showApproval(toolName, action),
        hideApproval: () => store.hideApproval(),
    };
}

async function stopActiveTurn(turn: ActiveCodingAgentTurn | undefined): Promise<undefined> {
    if (turn === undefined) return undefined;
    turn.interrupt('force');
    await turn.done;
    return undefined;
}

export function startChatAgentRunner(options: AgentRunnerOptions): AgentRunnerHandle {
    const store = options.store;
    const chatOutput = createStoreChatOutput(store);
    const pump = createStoreEventPump(store);

    let activeTurn: ActiveCodingAgentTurn | undefined;
    let exiting = false;
    let pendingInterrupt = false;
    let currentModelProviderSelection = options.modelProviderSelection;
    let currentApprovalLevel: ApprovalLevel | undefined = options.initialApprovalLevel;
    let currentSessionId: string | undefined = options.sessionId;
    if (currentSessionId !== undefined) {
        store.setSessionId(currentSessionId);
    }

    const parseLine: (value: string) => ChatLineAction =
        options.parseLine ??
        ((value: string) => {
            const parseOptions: ChatLineOptions = {
                ...(options.modelChoices !== undefined ? { modelChoices: options.modelChoices } : {}),
                ...(options.knownSkillNames !== undefined ? { knownSkillNames: options.knownSkillNames } : {}),
                ...(options.knownWorkflowNames !== undefined ? { knownWorkflowNames: options.knownWorkflowNames } : {}),
                ...(currentSessionId !== undefined ? { currentSessionId } : {}),
            };
            return parseChatLine(value, parseOptions);
        });

    const dispatch: (action: ChatLineAction, context: DispatchActionContext) => Promise<ChatActionResult> =
        options.dispatchAction ??
        (async (action: ChatLineAction, _context: DispatchActionContext): Promise<ChatActionResult> => {
            if (action.kind === 'empty') {
                return actionResult(currentModelProviderSelection);
            }
            throw new Error(
                `AgentRunner.dispatchAction not configured for action kind '${action.kind}'. ` +
                    'Provide options.dispatchAction for real prompt/tool/model dispatch.',
            );
        });

    const cleanup: () => Promise<void> =
        options.cleanup ??
        (async () => {
            await closeTreeSitterClient();
        });

    const appendHistory: (value: string) => Promise<void> = options.appendHistory ?? appendInputHistoryEntry;

    function computeState(): AgentRunnerState {
        if (exiting) return 'exiting';
        if (activeTurn === undefined) return 'idle';
        if (activeTurn.hasPendingApproval()) return 'awaiting-approval';
        return 'running';
    }

    async function readAfterActiveYield(): Promise<ChatInputEvent> {
        await sleep(YIELD_BEFORE_READ_MS);
        return pump.read();
    }

    function applyResult(result: ChatActionResult): void {
        if (
            result.modelProviderSelection.providerID !== currentModelProviderSelection.providerID ||
            result.modelProviderSelection.modelID !== currentModelProviderSelection.modelID ||
            result.modelProviderSelection.variantID !== currentModelProviderSelection.variantID
        ) {
            currentModelProviderSelection = result.modelProviderSelection;
        }
        activeTurn = result.activeTurn;
        if (result.sessionId !== undefined) {
            currentSessionId = result.sessionId;
            store.setSessionId(currentSessionId);
        }
        if (result.approvalLevel !== undefined && result.approvalLevel !== currentApprovalLevel) {
            currentApprovalLevel = result.approvalLevel;
            store.setApprovalLevel(currentApprovalLevel);
            options.permissionSession?.replaceBuiltInRules(approvalLevelRules(currentApprovalLevel));
        }
    }

    async function run(): Promise<void> {
        try {
            while (!exiting) {
                let event: ChatInputEvent;

                if (activeTurn === undefined) {
                    event = await pump.read();
                } else {
                    const outcome = await Promise.race<'completed' | ChatInputEvent>([
                        activeTurn.done.then((): 'completed' => 'completed'),
                        readAfterActiveYield(),
                    ]);
                    if (outcome === 'completed') {
                        activeTurn = undefined;
                        continue;
                    }
                    event = outcome;
                }

                if (exiting) break;

                if (event.type === 'interrupt') {
                    if (activeTurn !== undefined) {
                        activeTurn.interrupt('soft');
                        await activeTurn.done;
                        activeTurn = undefined;
                        pendingInterrupt = false;
                        chatOutput.write('\nPress Ctrl+C twice to exit\n');
                    } else if (event.source === 'esc') {
                        // ESC-sourced interrupts never count toward exit (G9).
                    } else if (pendingInterrupt && event.interruptedPartialInput !== true) {
                        chatOutput.write('\n');
                        exiting = true;
                        break;
                    } else {
                        pendingInterrupt = true;
                        chatOutput.write('\nPress Ctrl+C again to exit\n');
                    }
                    continue;
                }

                pendingInterrupt = false;
                const prompt = event.value.trim();

                // G3: approval routing before parse (double answerApproval).
                if (activeTurn?.hasPendingApproval() === true && activeTurn.answerApproval(prompt)) {
                    continue;
                }
                if (activeTurn?.answerApproval(prompt)) {
                    continue;
                }
                if (prompt.length === 0) {
                    continue;
                }
                if (prompt.length > maxChatPromptLength) {
                    chatOutput.write(`Prompt is too long (max ${maxChatPromptLength} characters).\n`);
                    continue;
                }

                await appendHistory(prompt);

                const action = parseLine(prompt);
                if (action.kind === 'exit') {
                    activeTurn = await stopActiveTurn(activeTurn);
                    chatOutput.write('Exiting mission-control chat\n');
                    exiting = true;
                    break;
                }

                store.setGenerating(true);
                let result: ChatActionResult;
                try {
                    result = await dispatch(action, { activeTurn });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    chatOutput.write(`Error: ${message}\n`);
                    store.setGenerating(false);
                    continue;
                }
                store.setGenerating(false);

                applyResult(result);
            }
        } finally {
            // G10: cleanup runs even on exception.
            activeTurn?.interrupt('force');
            try {
                await cleanup();
            } catch {
                // cleanup errors are non-fatal during teardown
            }
        }
    }

    const loopPromise = run();
    // Suppress unhandled rejection between loop exit and stop() call.
    loopPromise.catch(() => {});

    return {
        state: computeState,
        submit: (prompt: string) => {
            store.submitLine(prompt);
        },
        interrupt: (source: 'ctrl-c' | 'esc') => {
            store.sendInterrupt(source);
        },
        stop: async () => {
            exiting = true;
            activeTurn?.interrupt('force');
            store.enqueueEvent({ type: 'interrupt', source: 'ctrl-c' });
            try {
                await loopPromise;
            } catch {
                // loop exited via exception; cleanup already ran in finally
            }
        },
    };
}
