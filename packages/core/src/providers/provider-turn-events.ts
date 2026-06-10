import type { AgentEvent, ProtocolError, ProviderStreamChunk, RedactionMetadata } from '@mission-control/protocol';
import { credentialRedactionsForText, redactCredentialText } from './credential-resolver.js';
import type { ProviderTurnRunInput } from './provider-turn-types.js';

export function eventForProviderChunk(
    input: ProviderTurnRunInput,
    chunk: ProviderStreamChunk,
    timestamp: string,
): AgentEvent {
    const redactedChunk = redactProviderChunk(chunk);
    return {
        type: redactedChunk.kind === 'response_started' ? 'model.call.started' : eventTypeForChunk(redactedChunk),
        timestamp,
        sessionId: input.sessionId,
        taskId: input.turnId,
        message: messageForChunk(redactedChunk),
        modelProviderSelection: {
            providerID: input.providerID,
            modelID: input.modelID,
            ...(input.variantID !== undefined ? { variantID: input.variantID } : {}),
        },
        providerStreamChunk: redactedChunk,
        ...(redactedChunk.kind === 'response_completed'
            ? {
                  transcript: {
                      providerTurnId: input.turnId,
                      messageId: redactedChunk.message.messageId,
                      visibility: 'model_visible' as const,
                  },
              }
            : {}),
    };
}

export function redactProviderChunk(chunk: ProviderStreamChunk): ProviderStreamChunk {
    switch (chunk.kind) {
        case 'text_delta': {
            const redactions = redactionsForText(chunk.delta, chunk.redactions);
            return {
                ...chunk,
                delta: redactCredentialText(chunk.delta, []),
                ...redactionField(redactions),
            };
        }
        case 'tool_call_delta':
            return { ...chunk, argumentsDelta: redactCredentialText(chunk.argumentsDelta, []) };
        case 'tool_call_completed':
            return {
                ...chunk,
                toolCall: {
                    ...chunk.toolCall,
                    argumentsJson: redactCredentialText(chunk.toolCall.argumentsJson, []),
                },
            };
        case 'response_completed': {
            const redactions = redactionsForText(chunk.message.content, chunk.message.redactions);
            return {
                ...chunk,
                message: {
                    ...chunk.message,
                    content: redactCredentialText(chunk.message.content, []),
                    ...redactionField(redactions),
                },
            };
        }
        case 'response_failed': {
            const redactions = redactionsForText(chunk.error.message, chunk.error.redactions);
            return {
                ...chunk,
                error: {
                    ...chunk.error,
                    message: redactCredentialText(chunk.error.message, []),
                    ...redactionField(redactions),
                },
            };
        }
        case 'response_started':
            return chunk;
        default:
            return assertNever(chunk);
    }
}

export function responseStartedChunk(input: ProviderTurnRunInput, attempt: number): ProviderStreamChunk {
    return {
        kind: 'response_started',
        requestId: input.requestId,
        sequence: 0,
        sourceEventType: `deterministic.response.started.attempt.${attempt}`,
    };
}

export function responseFailedChunk(
    input: ProviderTurnRunInput,
    sequence: number,
    error: ProtocolError,
): ProviderStreamChunk {
    return {
        kind: 'response_failed',
        requestId: input.requestId,
        sequence,
        error,
    };
}

function eventTypeForChunk(chunk: ProviderStreamChunk): AgentEvent['type'] {
    switch (chunk.kind) {
        case 'text_delta':
        case 'tool_call_delta':
        case 'tool_call_completed':
            return 'task.progress';
        case 'response_completed':
        case 'response_failed':
            return 'model.call.completed';
        case 'response_started':
            return 'model.call.started';
        default:
            return assertNever(chunk);
    }
}

function messageForChunk(chunk: ProviderStreamChunk): string {
    switch (chunk.kind) {
        case 'text_delta':
            return chunk.delta;
        case 'tool_call_delta':
            return chunk.argumentsDelta;
        case 'tool_call_completed':
            return `tool call completed: ${chunk.toolCall.toolName}`;
        case 'response_completed':
            return chunk.message.content;
        case 'response_failed':
            return chunk.error.message;
        case 'response_started':
            return 'provider response started';
        default:
            return assertNever(chunk);
    }
}

function redactionsForText(text: string, existing: readonly RedactionMetadata[] | undefined): RedactionMetadata[] {
    return [...(existing ?? []), ...credentialRedactionsForText(text, [])];
}

function redactionField(redactions: readonly RedactionMetadata[]): { readonly redactions?: RedactionMetadata[] } {
    return redactions.length > 0 ? { redactions: [...redactions] } : {};
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected provider chunk: ${JSON.stringify(value)}`);
}
