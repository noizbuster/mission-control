import type { ModelProviderSelection } from '@mission-control/protocol';
import { closeTreeSitterClient } from '@mission-control/tui/highlight';
import type { ModelSelector } from './interactive-chat';
import type { ChatInput, ChatInputEvent } from './interactive-chat-io';
import type { ActiveCodingAgentTurn, ActiveCodingAgentTurnOutcome } from './interactive-coding-agent-types';
import {
    FORCE_INTERRUPT_SETTLE_TIMEOUT_MS,
    INTERRUPT_SETTLE_TIMEOUT_MS,
    interruptActiveTurnBounded as interruptActiveTurnBoundedImpl,
    PROCESS_SIGNAL_FORCE_EXIT_MS,
    registerProcessTerminalCleanup as registerProcessTerminalCleanupImpl,
    stopActiveTurn as stopActiveTurnImpl,
} from './interactive-interrupt-settlement';

export { FORCE_INTERRUPT_SETTLE_TIMEOUT_MS, INTERRUPT_SETTLE_TIMEOUT_MS, PROCESS_SIGNAL_FORCE_EXIT_MS };

export async function stopActiveTurn(activeTurn: ActiveCodingAgentTurn | undefined): Promise<undefined> {
    return stopActiveTurnImpl(activeTurn);
}

export async function interruptActiveTurnBounded(
    activeTurn: ActiveCodingAgentTurn,
    softTimeoutMs: number = INTERRUPT_SETTLE_TIMEOUT_MS,
    forceTimeoutMs: number = FORCE_INTERRUPT_SETTLE_TIMEOUT_MS,
): Promise<void> {
    return interruptActiveTurnBoundedImpl(activeTurn, softTimeoutMs, forceTimeoutMs);
}

export function areModelProviderSelectionsEqual(left: ModelProviderSelection, right: ModelProviderSelection): boolean {
    return left.providerID === right.providerID && left.modelID === right.modelID && left.variantID === right.variantID;
}

export function suspendChatInputWhileSelectingModel(selectModel: ModelSelector, input: ChatInput): ModelSelector {
    return async (choices, currentSelection, options) => {
        input.suspend?.();
        try {
            return await selectModel(choices, currentSelection, options);
        } finally {
            input.resume?.();
        }
    };
}

export function registerProcessTerminalCleanup(
    input: ChatInput,
    options: { readonly onForceExit?: () => void } = {},
): () => void {
    return registerProcessTerminalCleanupImpl(
        {
            close: () => input.close(),
            ...(options.onForceExit !== undefined ? { onForceExit: options.onForceExit } : {}),
        },
        () => {
            void closeTreeSitterClient();
        },
    );
}

type ChatLoopEvent =
    | {
          readonly type: 'input';
          readonly event: ChatInputEvent;
      }
    | {
          readonly type: 'active-completed';
          readonly outcome: ActiveCodingAgentTurnOutcome | undefined;
      };

export class ChatInputPump {
    private pending: Promise<ChatInputEvent> | undefined;

    constructor(private readonly input: ChatInput) {}

    read(): Promise<ChatInputEvent> {
        if (this.pending === undefined) {
            this.pending = this.input.read().finally(() => {
                this.pending = undefined;
            });
        }
        return this.pending;
    }
}

export async function nextChatLoopEvent(
    inputPump: ChatInputPump,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatLoopEvent> {
    if (activeTurn === undefined) {
        return { type: 'input', event: await inputPump.read() };
    }
    return Promise.race([completedTurnEvent(activeTurn), readAfterActiveYield(inputPump)]);
}

async function completedTurnEvent(activeTurn: ActiveCodingAgentTurn): Promise<ChatLoopEvent> {
    await activeTurn.done;
    return { type: 'active-completed', outcome: await activeTurn.outcome };
}

async function readAfterActiveYield(inputPump: ChatInputPump): Promise<ChatLoopEvent> {
    await new Promise((resolve) => {
        setTimeout(resolve, 25);
    });
    return { type: 'input', event: await inputPump.read() };
}
