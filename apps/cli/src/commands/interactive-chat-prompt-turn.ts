import type {
    AgentRuntime,
    CommandExecutionRequest,
    CommandExecutionResult,
    JsonlSessionEventStore,
    ProviderAdapter,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io.js';
import { type ActiveCodingAgentTurn, startCodingAgentTurn } from './interactive-coding-agent.js';

export type PromptTurnContext = {
    readonly provider: ProviderAdapter | undefined;
    readonly sessionId: string | undefined;
    readonly workspaceRoot: string | undefined;
    readonly commandExecutor: ((request: CommandExecutionRequest) => Promise<CommandExecutionResult>) | undefined;
    readonly emitEvent: ((event: AgentEvent) => void) | undefined;
    readonly observeStoredEvent: ((event: AgentEvent) => void) | undefined;
    readonly nextTurnId: () => string;
    readonly sessionStore: JsonlSessionEventStore | undefined;
};

export async function startPromptTurn(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    prompt: string,
    modelProviderSelection: ModelProviderSelection,
    coding: PromptTurnContext,
): Promise<ActiveCodingAgentTurn | undefined> {
    if (
        coding.provider === undefined ||
        coding.sessionId === undefined ||
        coding.workspaceRoot === undefined ||
        coding.sessionStore === undefined
    ) {
        const response = await runtime.runPromptTask(prompt);
        chatOutput.write(`Assistant: ${response}\n`);
        return undefined;
    }
    return startCodingAgentTurn({
        prompt,
        sessionId: coding.sessionId,
        turnId: coding.nextTurnId(),
        store: coding.sessionStore,
        provider: coding.provider,
        modelProviderSelection,
        workspaceRoot: coding.workspaceRoot,
        output: chatOutput,
        emitEvent: coding.emitEvent ?? (() => undefined),
        ...(coding.observeStoredEvent !== undefined ? { observeStoredEvent: coding.observeStoredEvent } : {}),
        ...(coding.commandExecutor !== undefined ? { commandExecutor: coding.commandExecutor } : {}),
    });
}
