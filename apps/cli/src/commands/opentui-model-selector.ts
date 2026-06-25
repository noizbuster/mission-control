import type { OpenTuiChatBridge } from './opentui-chat-bridge.js';
import type { ModelSelector } from './interactive-chat.js';

/**
 * Adapts the opentui model picker overlay to the `ModelSelector` contract
 * consumed by `runInteractiveChatSession`. The `currentSelection` and `options`
 * arguments are intentionally ignored: the overlay renders its own fixed title
 * and derives the choice list entirely from `choices`.
 */
export function createOpenTuiModelSelector(bridge: OpenTuiChatBridge): ModelSelector {
    return (choices) => bridge.showModelPicker(choices);
}
