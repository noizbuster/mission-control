export const defaultGeminiGenerateContentBaseEndpoint = 'https://generativelanguage.googleapis.com/v1beta';

export type GeminiTextPart = {
    readonly text: string;
};

export type GeminiFunctionCallPart = {
    readonly functionCall: {
        readonly name: string;
        readonly args: Readonly<Record<string, unknown>>;
        readonly id?: string;
    };
};

export type GeminiFunctionResponsePart = {
    readonly functionResponse: {
        readonly name: string;
        readonly response: Readonly<Record<string, unknown>>;
        readonly id?: string;
    };
};

export type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

export type GeminiContent = {
    readonly role: 'user' | 'model';
    readonly parts: readonly GeminiPart[];
};

export type GeminiFunctionDeclaration = {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
};

export type GeminiTool = {
    readonly functionDeclarations: readonly GeminiFunctionDeclaration[];
};

export type GeminiGenerateContentRequestBody = {
    readonly contents: readonly GeminiContent[];
    readonly systemInstruction?: {
        readonly parts: readonly GeminiTextPart[];
    };
    readonly tools?: readonly GeminiTool[];
};

export type GeminiGenerateContentTransportRequest = {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: GeminiGenerateContentRequestBody;
    readonly signal: AbortSignal;
};

export interface GeminiGenerateContentTransport {
    readonly stream: (request: GeminiGenerateContentTransportRequest) => AsyncIterable<unknown>;
}

export type GeminiGenerateContentTransportErrorInput = {
    readonly status?: number;
    readonly kind?: 'timeout' | 'abort' | 'network';
    readonly code?: string;
    readonly message: string;
};

export class GeminiGenerateContentTransportError extends Error {
    readonly name = 'GeminiGenerateContentTransportError';
    readonly status?: number;
    readonly kind?: 'timeout' | 'abort' | 'network';
    readonly code?: string;

    constructor(input: GeminiGenerateContentTransportErrorInput) {
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
