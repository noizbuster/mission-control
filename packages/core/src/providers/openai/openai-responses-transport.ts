import type { AgentMessage } from '@mission-control/protocol';

export const defaultOpenAIResponsesEndpoint = 'https://api.openai.com/v1/responses';

export type OpenAIResponsesInputMessage = {
    readonly role: AgentMessage['role'];
    readonly content: string;
};

export type OpenAIResponsesTool = {
    readonly type: 'function';
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
};

export type OpenAIResponsesRequestBody = {
    readonly model: string;
    readonly input: readonly OpenAIResponsesInputMessage[];
    readonly stream: true;
    readonly store: false;
    readonly stream_options: {
        readonly include_obfuscation: false;
    };
    readonly tools?: readonly OpenAIResponsesTool[];
};

export type OpenAIResponsesTransportRequest = {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: OpenAIResponsesRequestBody;
    readonly signal: AbortSignal;
};

export interface OpenAIResponsesTransport {
    readonly stream: (request: OpenAIResponsesTransportRequest) => AsyncIterable<unknown>;
}

export type OpenAIResponsesTransportErrorInput = {
    readonly status?: number;
    readonly kind?: 'timeout' | 'abort' | 'network';
    readonly code?: string;
    readonly message: string;
};

export class OpenAIResponsesTransportError extends Error {
    readonly name = 'OpenAIResponsesTransportError';
    readonly status?: number;
    readonly kind?: 'timeout' | 'abort' | 'network';
    readonly code?: string;

    constructor(input: OpenAIResponsesTransportErrorInput) {
        super(input.message);
        if (input.status !== undefined) {
            this.status = input.status;
        }
        if (input.kind !== undefined) {
            this.kind = input.kind;
        }
        if (input.code !== undefined) {
            this.code = input.code;
        }
    }
}
