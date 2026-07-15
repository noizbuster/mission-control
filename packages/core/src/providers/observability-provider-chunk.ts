import { type ProtocolError, type ProviderStreamChunk, ProviderStreamChunkSchema } from '@mission-control/protocol';
import type { ObservabilityRedactor } from './observability-value-redactor';
import { redactProviderChunk } from './provider-turn-events';

const PROVIDER_CHUNK_REDACTION_FAILURE = 'Provider stream chunk could not be redacted';

export function redactProviderChunkForObservability(
    chunk: ProviderStreamChunk,
    redactor: ObservabilityRedactor,
): ProviderStreamChunk {
    try {
        return redactObservableProviderChunk(redactProviderChunk(chunk), redactor);
    } catch {
        throw new TypeError(PROVIDER_CHUNK_REDACTION_FAILURE);
    }
}

export function guardProviderChunkForObservability(chunk: ProviderStreamChunk): ProviderStreamChunk {
    try {
        return ProviderStreamChunkSchema.parse(chunk);
    } catch {
        throw new TypeError(PROVIDER_CHUNK_REDACTION_FAILURE);
    }
}

function redactObservableProviderChunk(
    chunk: ProviderStreamChunk,
    redactor: ObservabilityRedactor,
): ProviderStreamChunk {
    const common = {
        ...(chunk.sourceEventType !== undefined ? { sourceEventType: redactor.redactText(chunk.sourceEventType) } : {}),
        ...(chunk.providerResponseId !== undefined
            ? { providerResponseId: redactor.redactIdentifier(chunk.providerResponseId) }
            : {}),
    };
    switch (chunk.kind) {
        case 'text_delta':
        case 'reasoning_delta':
            return {
                ...chunk,
                ...common,
                requestId: redactor.redactIdentifier(chunk.requestId),
                delta: redactor.redactText(chunk.delta),
            };
        case 'reasoning_completed':
            return {
                ...chunk,
                ...common,
                requestId: redactor.redactIdentifier(chunk.requestId),
                text: redactor.redactText(chunk.text),
            };
        case 'tool_call_delta':
            return {
                ...chunk,
                ...common,
                requestId: redactor.redactIdentifier(chunk.requestId),
                toolCallId: redactor.redactIdentifier(chunk.toolCallId),
                ...(chunk.providerCallId !== undefined
                    ? { providerCallId: redactor.redactIdentifier(chunk.providerCallId) }
                    : {}),
                ...(chunk.providerItemId !== undefined
                    ? { providerItemId: redactor.redactIdentifier(chunk.providerItemId) }
                    : {}),
                argumentsDelta: redactor.redactText(chunk.argumentsDelta),
            };
        case 'tool_call_completed':
            return {
                ...chunk,
                ...common,
                requestId: redactor.redactIdentifier(chunk.requestId),
                toolCall: {
                    ...chunk.toolCall,
                    toolCallId: redactor.redactIdentifier(chunk.toolCall.toolCallId),
                    ...(chunk.toolCall.providerCallId !== undefined
                        ? { providerCallId: redactor.redactIdentifier(chunk.toolCall.providerCallId) }
                        : {}),
                    ...(chunk.toolCall.providerItemId !== undefined
                        ? { providerItemId: redactor.redactIdentifier(chunk.toolCall.providerItemId) }
                        : {}),
                    argumentsJson: redactor.redactText(chunk.toolCall.argumentsJson),
                },
            };
        case 'response_completed':
            return {
                ...chunk,
                ...common,
                requestId: redactor.redactIdentifier(chunk.requestId),
                message: {
                    ...chunk.message,
                    messageId: redactor.redactIdentifier(chunk.message.messageId),
                    content: redactor.redactText(chunk.message.content),
                    ...(chunk.message.reasoning !== undefined
                        ? { reasoning: redactor.redactText(chunk.message.reasoning) }
                        : {}),
                    ...(chunk.message.toolCallIds !== undefined
                        ? { toolCallIds: chunk.message.toolCallIds.map(redactor.redactIdentifier) }
                        : {}),
                    ...(chunk.message.providerToolCalls !== undefined
                        ? {
                              providerToolCalls: chunk.message.providerToolCalls.map((call) => ({
                                  ...call,
                                  toolCallId: redactor.redactIdentifier(call.toolCallId),
                                  ...(call.providerCallId !== undefined
                                      ? { providerCallId: redactor.redactIdentifier(call.providerCallId) }
                                      : {}),
                                  ...(call.providerItemId !== undefined
                                      ? { providerItemId: redactor.redactIdentifier(call.providerItemId) }
                                      : {}),
                                  argumentsJson: redactor.redactText(call.argumentsJson),
                              })),
                          }
                        : {}),
                },
            };
        case 'response_failed':
            return {
                ...chunk,
                ...common,
                requestId: redactor.redactIdentifier(chunk.requestId),
                error: redactProtocolError(chunk.error, redactor),
            };
        case 'response_started':
            return { ...chunk, ...common, requestId: redactor.redactIdentifier(chunk.requestId) };
        default:
            return assertNever(chunk);
    }
}

export function redactProtocolError(error: ProtocolError, redactor: ObservabilityRedactor): ProtocolError {
    return { ...error, message: redactor.redactText(error.message) };
}

function assertNever(_value: never): never {
    throw new TypeError('Unhandled provider stream chunk');
}
