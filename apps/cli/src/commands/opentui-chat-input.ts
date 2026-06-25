import type { OpenTuiChatBridge } from './opentui-chat-bridge.js';
import type { ChatInput, ChatInputEvent } from './interactive-chat-io.js';

/**
 * Adapts an `OpenTuiChatBridge` to the `ChatInput` interface consumed by
 * `runInteractiveChatSession`. `read()` delegates to
 * `bridge.waitForEvent()`, `close()` unmounts the opentui tree, and
 * `controlsPrompt` is `true` because the bridge renders its own prompt.
 * `suspend`, `resume`, and `renderPrompt` are no-ops since the bridge owns
 * raw-mode handling and prompt rendering internally.
 */
export function createOpenTuiChatInput(bridge: OpenTuiChatBridge): ChatInput {
    return {
        read: (): Promise<ChatInputEvent> => bridge.waitForEvent(),
        close: () => bridge.unmount(),
        suspend: () => {},
        resume: () => {},
        controlsPrompt: true,
        renderPrompt: () => {},
    };
}
