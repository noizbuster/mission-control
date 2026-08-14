import type { ChatOutput } from './interactive-chat-io';
import type { ChatStore } from '@mission-control/tui/state';

/**
 * Adapts a `ChatStore` to the `ChatOutput` interface. The store handles the
 * 16ms coalescing on `emitOutput` (G6) and owns all UI state mutations.
 */
export function createStoreChatOutput(store: ChatStore): ChatOutput {
    return {
        write: (text: string) => store.emitOutput(text),
        writeTranscriptPart: (part, fallbackText) => store.emitTranscriptPart(part, fallbackText),
        writeTranscriptFallback: (text: string) => store.emitTranscriptFallback(text),
        getOutput: () => store.getOutput(),
        setAgentStatus: (text: string) => store.setAgentStatus(text),
        setAgentRetryStatus: (text: string, retryAt: number) => store.setAgentRetryStatus(text, retryAt),
        clearAgentStatus: () => store.clearAgentStatus(),
        isShowThinking: () => store.getSnapshot().showThinking,
        isToolOutputExpanded: () => store.getSnapshot().toolOutputExpanded,
        showApproval: (toolName: string, action: string) => store.showApproval(toolName, action),
        hideApproval: () => store.hideApproval(),
    };
}
