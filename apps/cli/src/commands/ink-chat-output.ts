import type { InkChatBridge } from './ink-chat-bridge.js';
import type { ChatOutput } from './interactive-chat-io.js';

/**
 * Adapter that exposes an {@link InkChatBridge} as a {@link ChatOutput}.
 *
 * The imperative chat loop speaks the `ChatOutput` interface; this bridges it
 * to the Ink-backed bridge by delegating writes to `emitOutput` (which appends
 * to the bridge's internal output string and triggers an Ink re-render) and
 * reads back via `getOutput`.
 */
export function createInkChatOutput(bridge: InkChatBridge): ChatOutput {
    return {
        write: (text: string) => {
            bridge.emitOutput(text);
        },
        getOutput: () => bridge.getOutput(),
    };
}
