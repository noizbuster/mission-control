import type { ModelProviderSelection } from '@mission-control/protocol';
import { closeTreeSitterClient } from '@mission-control/tui/highlight';
import type { ModelSelector } from './interactive-chat';
import type { ChatInput, ChatInputEvent } from './interactive-chat-io';
import type { ActiveCodingAgentTurn, ActiveCodingAgentTurnOutcome } from './interactive-coding-agent';

export async function stopActiveTurn(activeTurn: ActiveCodingAgentTurn | undefined): Promise<undefined> {
    if (activeTurn === undefined) {
        return undefined;
    }
    activeTurn.interrupt('force');
    await activeTurn.done;
    return undefined;
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

export function registerProcessTerminalCleanup(input: ChatInput): () => void {
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) {
            return;
        }
        cleaned = true;
        input.close();
        // Signal/exit handlers are sync, so we cannot await; the call is idempotent.
        void closeTreeSitterClient();
    };
    const onSignal = () => {
        cleanup();
    };
    const onExit = () => {
        cleanup();
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('exit', onExit);

    return () => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('exit', onExit);
    };
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
