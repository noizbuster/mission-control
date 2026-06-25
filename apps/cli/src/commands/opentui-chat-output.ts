import type { OpenTuiChatBridge } from './opentui-chat-bridge.js';
import type { ChatOutput } from './interactive-chat-io.js';

/**
 * Adapter that exposes an {@link OpenTuiChatBridge} as a {@link ChatOutput}.
 *
 * The imperative chat loop speaks the `ChatOutput` interface; this bridges it
 * to the opentui-backed bridge by delegating writes to `emitOutput` (which
 * appends to the bridge's internal output string and triggers a re-render) and
 * reads back via `getOutput`.
 */
export function createOpenTuiChatOutput(bridge: OpenTuiChatBridge): ChatOutput {
    return {
        write: (text: string) => {
            bridge.emitOutput(text);
        },
        getOutput: () => bridge.getOutput(),
        setAgentStatus: (text: string) => {
            bridge.setAgentStatus(text);
        },
        clearAgentStatus: () => {
            bridge.clearAgentStatus();
        },
        isShowThinking: () => bridge.isShowThinking(),
        isToolOutputExpanded: () => bridge.isToolOutputExpanded(),
        showApproval: (toolName: string, action: string) => {
            bridge.showApproval(toolName, action);
        },
        hideApproval: () => {
            bridge.hideApproval();
        },
    };
}
