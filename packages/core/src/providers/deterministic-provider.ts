import type { ProtocolError, ProviderStreamChunk, ProviderUsage } from '@mission-control/protocol';
import {
    type ProviderAdapter,
    type ProviderAdapterContext,
    ProviderTurnError,
    type ProviderTurnRequest,
} from './provider-turn-types.js';

export type DeterministicProviderStep =
    | {
          readonly kind: 'text_delta';
          readonly delta: string;
          readonly sourceEventType?: string;
      }
    | {
          readonly kind: 'tool_call_delta';
          readonly toolCallId: string;
          readonly argumentsDelta: string;
      }
    | {
          readonly kind: 'tool_call_completed';
          readonly toolCallId: string;
          readonly toolName: string;
          readonly argumentsJson: string;
      }
    | {
          readonly kind: 'response_completed';
          readonly content: string;
          readonly finishReason?:
              | 'stop'
              | 'length'
              | 'tool_calls'
              | 'content_filter'
              | 'cancelled'
              | 'error'
              | 'unknown';
          readonly usage?: ProviderUsage;
      }
    | {
          readonly kind: 'response_failed';
          readonly error: ProtocolError;
      }
    | {
          readonly kind: 'wait';
          readonly ms: number;
      };

type DeterministicProviderAttempt = readonly DeterministicProviderStep[];
type DeterministicProviderScript = readonly DeterministicProviderStep[] | readonly DeterministicProviderAttempt[];

export type DeterministicProvider = ProviderAdapter & {
    readonly attemptCount: () => number;
};

export function createDeterministicProvider(script: DeterministicProviderScript): DeterministicProvider {
    const attempts = normalizeScript(script);
    let attemptsStarted = 0;

    return {
        async *streamTurn(request: ProviderTurnRequest, context: ProviderAdapterContext) {
            attemptsStarted += 1;
            const selected = attempts.at(context.attempt - 1) ?? attempts.at(-1) ?? [];
            let sequence = 1;
            for (const step of selected) {
                if (context.signal.aborted) {
                    throw new ProviderTurnError(abortedError());
                }
                if (step.kind === 'wait') {
                    await waitFor(step.ms, context.signal);
                    continue;
                }
                yield chunkForStep(step, request, sequence);
                sequence += 1;
            }
        },
        attemptCount() {
            return attemptsStarted;
        },
    };
}

function normalizeScript(script: DeterministicProviderScript): readonly DeterministicProviderAttempt[] {
    if (isStepList(script)) {
        return [script];
    }
    return script;
}

function isStepList(script: DeterministicProviderScript): script is readonly DeterministicProviderStep[] {
    const first = script.at(0);
    return first === undefined || !Array.isArray(first);
}

function chunkForStep(
    step: Exclude<DeterministicProviderStep, { readonly kind: 'wait' }>,
    request: ProviderTurnRequest,
    sequence: number,
): ProviderStreamChunk {
    switch (step.kind) {
        case 'text_delta':
            return {
                kind: 'text_delta',
                requestId: request.requestId,
                sequence,
                ...(step.sourceEventType !== undefined ? { sourceEventType: step.sourceEventType } : {}),
                delta: step.delta,
            };
        case 'tool_call_delta':
            return {
                kind: 'tool_call_delta',
                requestId: request.requestId,
                sequence,
                toolCallId: step.toolCallId,
                argumentsDelta: step.argumentsDelta,
            };
        case 'tool_call_completed':
            return {
                kind: 'tool_call_completed',
                requestId: request.requestId,
                sequence,
                toolCall: {
                    toolCallId: step.toolCallId,
                    toolName: step.toolName,
                    argumentsJson: step.argumentsJson,
                },
            };
        case 'response_completed':
            return {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant',
                    content: step.content,
                },
                finishReason: step.finishReason ?? 'stop',
                ...(step.usage !== undefined ? { usage: step.usage } : {}),
            };
        case 'response_failed':
            return {
                kind: 'response_failed',
                requestId: request.requestId,
                sequence,
                error: step.error,
            };
        default:
            return assertNever(step);
    }
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(new ProviderTurnError(abortedError()));
    }
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            reject(new ProviderTurnError(abortedError()));
        };
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}

function abortedError(): ProtocolError {
    return {
        code: 'provider_aborted',
        message: 'provider turn aborted',
        retryable: false,
    };
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected deterministic provider step: ${JSON.stringify(value)}`);
}
