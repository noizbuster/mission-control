import type { InkChatBridge } from './ink-chat-bridge.js';
import type { ChatInput, ChatInputEvent } from './interactive-chat-io.js';

/**
 * Adapts an `InkChatBridge` to the `ChatInput` interface consumed by
 * `runInteractiveChatSession`. `read()` delegates to
 * `bridge.waitForEvent()`, `close()` unmounts the Ink tree, and
 * `controlsPrompt` is `false` because Ink renders its own prompt.
 * `suspend`, `resume`, and `renderPrompt` are no-ops since Ink owns
 * raw-mode handling and prompt rendering internally.
 */
export function createInkChatInput(bridge: InkChatBridge): ChatInput {
    return {
        read: (): Promise<ChatInputEvent> => bridge.waitForEvent(),
        close: () => bridge.unmount(),
        suspend: () => {},
        resume: () => {},
        controlsPrompt: false,
        renderPrompt: () => {},
    };
}
