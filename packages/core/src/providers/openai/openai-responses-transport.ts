import type { TextAgentMessage } from '@mission-control/protocol';

export const defaultOpenAIResponsesEndpoint = 'https://api.openai.com/v1/responses';

export type OpenAIResponsesInputMessage = {
    readonly role: TextAgentMessage['role'];
    readonly content: string;
};

export type OpenAIResponsesFunctionCallOutput = {
    readonly type: 'function_call_output';
    readonly call_id: string;
    readonly output: string;
};

export type OpenAIResponsesFunctionCallInput = {
    readonly type: 'function_call';
    readonly id: string;
    readonly call_id: string;
    readonly name: string;
    readonly arguments: string;
};

export type OpenAIResponsesInputItem =
    | OpenAIResponsesInputMessage
    | OpenAIResponsesFunctionCallInput
    | OpenAIResponsesFunctionCallOutput;

export type OpenAIResponsesTool = {
    readonly type: 'function';
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
};

export type OpenAIReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type OpenAIResponsesRequestBody = {
    readonly model: string;
    readonly input: readonly OpenAIResponsesInputItem[];
    readonly stream: true;
    readonly store: false;
    readonly stream_options: {
        readonly include_obfuscation: false;
    };
    readonly reasoning?: {
        readonly effort: OpenAIReasoningEffort;
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
