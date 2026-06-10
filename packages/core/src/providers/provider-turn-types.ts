import type {
    AgentEvent,
    AgentEventEnvelope,
    AgentMessage,
    ProtocolError,
    ProviderStreamChunk,
    ToolDefinition,
} from '@mission-control/protocol';

export interface ProviderAdapter {
    readonly streamTurn: (
        request: ProviderTurnRequest,
        context: ProviderAdapterContext,
    ) => AsyncIterable<ProviderStreamChunk>;
}

export type ProviderAdapterContext = {
    readonly attempt: number;
    readonly signal: AbortSignal;
};

export type ProviderTurnRequest = {
    readonly requestId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly providerID: string;
    readonly modelID: string;
    readonly messages: readonly AgentMessage[];
    readonly tools?: readonly ToolDefinition[];
};

export type ProviderTurnEventWriter = (envelope: AgentEventEnvelope) => Promise<void>;
export type ProviderTurnEnvelopeObserver = (envelope: AgentEventEnvelope) => void;
export type ProviderTurnEventIdFactory = (event: AgentEvent, sequence: number) => string;

export type ProviderTurnRunInput = ProviderTurnRequest & {
    readonly startSequence: number;
    readonly signal?: AbortSignal;
    readonly writeEnvelope?: ProviderTurnEventWriter;
    readonly onEnvelope?: ProviderTurnEnvelopeObserver;
};

export type ProviderTurnRunResult =
    | {
          readonly status: 'completed';
          readonly message: Extract<ProviderStreamChunk, { readonly kind: 'response_completed' }>['message'];
          readonly attempts: number;
          readonly envelopes: readonly AgentEventEnvelope[];
      }
    | {
          readonly status: 'failed';
          readonly error: ProtocolError;
          readonly attempts: number;
          readonly envelopes: readonly AgentEventEnvelope[];
      };

export type ProviderTurnRunnerOptions = {
    readonly provider: ProviderAdapter;
    readonly now?: () => string;
    readonly createEventId?: ProviderTurnEventIdFactory;
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
};

export class ProviderTurnError extends Error {
    readonly name = 'ProviderTurnError';
    readonly error: ProtocolError;

    constructor(error: ProtocolError) {
        super(error.message);
        this.error = error;
    }
}
