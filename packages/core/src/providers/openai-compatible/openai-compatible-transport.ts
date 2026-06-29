export type OpenAICompatibleChatToolCall = {
    readonly id: string;
    readonly type: 'function';
    readonly function: {
        readonly name: string;
        readonly arguments: string;
    };
};

export type OpenAICompatibleChatMessage =
    | {
          readonly role: 'system' | 'user';
          readonly content: string;
      }
    | {
          readonly role: 'assistant';
          readonly content: string;
          readonly tool_calls?: readonly OpenAICompatibleChatToolCall[];
      }
    | {
          readonly role: 'tool';
          readonly tool_call_id: string;
          readonly content: string;
      };

export type OpenAICompatibleTool = {
    readonly type: 'function';
    readonly function: {
        readonly name: string;
        readonly description: string;
        readonly parameters: Readonly<Record<string, unknown>>;
    };
};

export type OpenAICompatibleRequestBody = {
    readonly model: string;
    readonly messages: readonly OpenAICompatibleChatMessage[];
    readonly stream: true;
    readonly tools?: readonly OpenAICompatibleTool[];
    readonly reasoning_effort?: string;
    readonly reasoning?: { readonly effort: string };
};

export type OpenAICompatibleTransportRequest = {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: OpenAICompatibleRequestBody;
    readonly signal: AbortSignal;
};

export interface OpenAICompatibleTransport {
    readonly stream: (request: OpenAICompatibleTransportRequest) => AsyncIterable<unknown>;
}

export type OpenAICompatibleTransportErrorInput = {
    readonly status?: number;
    readonly kind?: 'timeout' | 'abort' | 'network';
    readonly code?: string;
    readonly message: string;
};

export class OpenAICompatibleTransportError extends Error {
    readonly name = 'OpenAICompatibleTransportError';
    readonly status?: number;
    readonly kind?: 'timeout' | 'abort' | 'network';
    readonly code?: string;

    constructor(input: OpenAICompatibleTransportErrorInput) {
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
