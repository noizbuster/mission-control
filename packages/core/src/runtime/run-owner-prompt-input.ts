import type { RunCoordinatorPromptInput } from './run-coordinator-types.js';

export function promptInput(input: RunCoordinatorPromptInput): RunCoordinatorPromptInput {
    return {
        prompt: input.prompt,
        ...(input.inputId !== undefined ? { inputId: input.inputId } : {}),
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
        ...(input.resume !== undefined ? { resume: input.resume } : {}),
        ...(input.providerTurnId !== undefined ? { providerTurnId: input.providerTurnId } : {}),
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    };
}
