export const defaultAnthropicMessagesEndpoint = 'https://api.anthropic.com/v1/messages';
export const defaultAnthropicVersion = '2023-06-01';
export const defaultAnthropicMaxTokens = 4096;

export type AnthropicTextContentBlock = {
    readonly type: 'text';
    readonly text: string;
};

export type AnthropicToolUseContentBlock = {
    readonly type: 'tool_use';
    readonly id: string;
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
};

export type AnthropicToolResultContentBlock = {
    readonly type: 'tool_result';
    readonly tool_use_id: string;
    readonly content?: string;
    readonly is_error?: true;
};

export type AnthropicContentBlock =
    | AnthropicTextContentBlock
    | AnthropicToolUseContentBlock
    | AnthropicToolResultContentBlock;

export type AnthropicRequestMessage = {
    readonly role: 'user' | 'assistant';
    readonly content: string | readonly AnthropicContentBlock[];
};

export type AnthropicToolDefinition = {
    readonly name: string;
    readonly description: string;
    readonly input_schema: Readonly<Record<string, unknown>>;
};

export type AnthropicThinkingConfig = {
    readonly type: 'enabled';
    readonly budget_tokens: number;
};

export type AnthropicMessagesRequestBody = {
    readonly model: string;
    readonly max_tokens: number;
    readonly stream: true;
    readonly system?: string;
    readonly messages: readonly AnthropicRequestMessage[];
    readonly tools?: readonly AnthropicToolDefinition[];
    readonly thinking?: AnthropicThinkingConfig;
};

export type AnthropicMessagesTransportRequest = {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: AnthropicMessagesRequestBody;
    readonly signal: AbortSignal;
};

export interface AnthropicMessagesTransport {
    readonly stream: (request: AnthropicMessagesTransportRequest) => AsyncIterable<unknown>;
}

export type AnthropicMessagesTransportErrorInput = {
    readonly status?: number;
    readonly kind?: 'timeout' | 'abort' | 'network';
    readonly code?: string;
    readonly message: string;
};

export class AnthropicMessagesTransportError extends Error {
    readonly name = 'AnthropicMessagesTransportError';
    readonly status?: number;
    readonly kind?: 'timeout' | 'abort' | 'network';
    readonly code?: string;

    constructor(input: AnthropicMessagesTransportErrorInput) {
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
