import { modelProviderCatalog } from '@mission-control/config';
import type {
    AgentMessage,
    ProviderCredential,
    ProviderToolCallTranscript,
    ToolDefinition,
} from '@mission-control/protocol';
import { ProviderCredentialResolutionError, type ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnError, type ProviderTurnRequest } from '../provider-turn-types.js';
import {
    defaultGeminiGenerateContentBaseEndpoint,
    type GeminiContent,
    type GeminiFunctionDeclaration,
    type GeminiFunctionResponsePart,
    type GeminiGenerateContentRequestBody,
    type GeminiGenerateContentTransportRequest,
    type GeminiPart,
} from './gemini-generate-content-transport.js';

const API_KEY_FIELD = 'apiKey';
const GOOGLE_PROVIDER_ID = 'google';

export async function resolveGeminiCredential(
    resolver: ProviderCredentialResolver,
    providerID: string,
): Promise<ProviderCredential> {
    try {
        return await resolver.resolveRequiredProviderCredential({ providerID });
    } catch (error) {
        if (error instanceof ProviderCredentialResolutionError) {
            throw new ProviderTurnError({
                code: 'provider_auth_failed',
                message: error.message,
                retryable: false,
                ...(error.redactions.length > 0 ? { redactions: [...error.redactions] } : {}),
            });
        }
        throw error;
    }
}

export function createGeminiGenerateContentTransportRequest(input: {
    readonly request: ProviderTurnRequest;
    readonly apiKey: string;
    readonly signal: AbortSignal;
    readonly baseEndpoint?: string;
}): GeminiGenerateContentTransportRequest {
    return {
        endpoint: endpointForModel(
            input.baseEndpoint ?? defaultGeminiGenerateContentBaseEndpoint,
            input.request.modelID,
        ),
        signal: input.signal,
        headers: {
            'x-goog-api-key': input.apiKey,
            'Content-Type': 'application/json',
        },
        body: createRequestBody(input.request),
    };
}

export function apiKeyForGeminiCredential(credential: ProviderCredential): string {
    switch (credential.type) {
        case 'apiKey':
            return credential.apiKey;
        case 'fields': {
            const apiKeyField = credential.fields[API_KEY_FIELD];
            if (apiKeyField?.secret === true) {
                return apiKeyField.value;
            }
            throw missingApiKeyError(credential.providerID);
        }
        case 'oauth':
            throw missingApiKeyError(credential.providerID);
        default:
            return assertNever(credential);
    }
}

function createRequestBody(request: ProviderTurnRequest): GeminiGenerateContentRequestBody {
    const systemInstruction = systemInstructionFromMessages(request.messages);
    const contents = geminiContentsFromAgentMessages(request.messages);
    const functionDeclarations = (request.tools ?? []).map(geminiFunctionDeclarationForTool);
    const generationConfig = geminiThinkingForVariant(request.modelID, request.variantID);
    return {
        contents,
        ...(systemInstruction !== undefined ? { systemInstruction } : {}),
        ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
        ...(generationConfig !== undefined ? { generationConfig } : {}),
    };
}

function geminiThinkingForVariant(
    modelID: string,
    variantID: string | undefined,
): { readonly thinkingConfig: { readonly thinkingBudget: number; readonly includeThoughts: true } } | undefined {
    if (variantID === undefined || !isConfiguredGeminiVariant(modelID, variantID)) {
        return undefined;
    }
    switch (variantID) {
        case 'thinking-low':
            return { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } };
        case 'thinking-medium':
            return { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } };
        case 'thinking-high':
            return { thinkingConfig: { thinkingBudget: 24576, includeThoughts: true } };
        default:
            return undefined;
    }
}

function isConfiguredGeminiVariant(modelID: string, variantID: string): boolean {
    const googleProvider = modelProviderCatalog.find((provider) => provider.id === GOOGLE_PROVIDER_ID);
    const model = googleProvider?.models.find((entry) => entry.id === modelID);
    return (model?.variants ?? []).some((variant) => variant.id === variantID);
}

function systemInstructionFromMessages(
    messages: readonly AgentMessage[],
): { readonly parts: readonly [{ readonly text: string }] } | undefined {
    const text = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
    return text.length === 0 ? undefined : { parts: [{ text }] };
}

function geminiContentsFromAgentMessages(messages: readonly AgentMessage[]): readonly GeminiContent[] {
    const toolCallsById = googleToolCallsById(messages);
    const output: GeminiContent[] = [];
    let index = 0;
    while (index < messages.length) {
        const message = messages[index];
        if (message === undefined) {
            index += 1;
            continue;
        }
        if (message.role === 'tool') {
            const grouped = groupedToolResponses(messages, index, toolCallsById);
            output.push({ role: 'user', parts: grouped.parts });
            index = grouped.nextIndex;
            continue;
        }
        const mapped = geminiContentFromTextMessage(message);
        if (mapped !== undefined) {
            output.push(mapped);
        }
        index += 1;
    }
    return output;
}

function geminiContentFromTextMessage(
    message: Exclude<AgentMessage, { readonly role: 'tool' }>,
): GeminiContent | undefined {
    switch (message.role) {
        case 'system':
            return undefined;
        case 'user':
            return { role: 'user', parts: [{ text: message.content }] };
        case 'assistant': {
            const functionParts = (message.providerToolCalls ?? [])
                .filter((toolCall) => toolCall.providerID === GOOGLE_PROVIDER_ID)
                .map(geminiFunctionCallPart);
            const textParts = message.content.length === 0 ? [] : [{ text: message.content }];
            return { role: 'model', parts: [...textParts, ...functionParts] };
        }
        default:
            return assertNever(message);
    }
}

function groupedToolResponses(
    messages: readonly AgentMessage[],
    startIndex: number,
    toolCallsById: ReadonlyMap<string, ProviderToolCallTranscript>,
): { readonly parts: readonly GeminiFunctionResponsePart[]; readonly nextIndex: number } {
    const parts: GeminiFunctionResponsePart[] = [];
    let index = startIndex;
    while (index < messages.length) {
        const message = messages[index];
        if (message?.role !== 'tool') {
            break;
        }
        parts.push(geminiFunctionResponsePart(message, toolCallsById));
        index += 1;
    }
    return { parts, nextIndex: index };
}

function geminiFunctionCallPart(toolCall: ProviderToolCallTranscript): GeminiPart {
    return {
        functionCall: {
            name: toolCall.toolName,
            args: parseToolInput(toolCall.argumentsJson),
            ...(toolCall.providerCallId !== undefined ? { id: toolCall.providerCallId } : {}),
        },
    };
}

function geminiFunctionResponsePart(
    message: Extract<AgentMessage, { readonly role: 'tool' }>,
    toolCallsById: ReadonlyMap<string, ProviderToolCallTranscript>,
): GeminiFunctionResponsePart {
    const toolCall = toolCallsById.get(message.toolCallId);
    if (toolCall === undefined) {
        throw new ProviderTurnError({
            code: 'schema_invalid',
            message: `Gemini tool result is missing provider metadata for ${message.toolCallId}`,
            retryable: false,
        });
    }
    return {
        functionResponse: {
            name: toolCall.toolName,
            response: toolResponseObject(message),
            ...(toolCall.providerCallId !== undefined ? { id: toolCall.providerCallId } : {}),
        },
    };
}

function toolResponseObject(
    message: Extract<AgentMessage, { readonly role: 'tool' }>,
): Readonly<Record<string, unknown>> {
    if (message.status === 'failed') {
        return {
            error: message.error === undefined ? 'tool failed' : `${message.error.code}: ${message.error.message}`,
        };
    }
    return message.output === undefined ? {} : { output: message.output };
}

function googleToolCallsById(messages: readonly AgentMessage[]): ReadonlyMap<string, ProviderToolCallTranscript> {
    return new Map(
        messages.flatMap((message) =>
            message.role === 'assistant'
                ? (message.providerToolCalls ?? [])
                      .filter((toolCall) => toolCall.providerID === GOOGLE_PROVIDER_ID)
                      .map((toolCall) => [toolCall.toolCallId, toolCall] as const)
                : [],
        ),
    );
}

function geminiFunctionDeclarationForTool(tool: ToolDefinition): GeminiFunctionDeclaration {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersJsonSchema,
    };
}

function parseToolInput(argumentsJson: string): Readonly<Record<string, unknown>> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(argumentsJson);
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new ProviderTurnError({
                code: 'schema_invalid',
                message: `Gemini function call args are not valid JSON: ${error.message}`,
                retryable: false,
            });
        }
        throw error;
    }
    if (isRecord(parsed)) {
        return parsed;
    }
    throw new ProviderTurnError({
        code: 'schema_invalid',
        message: 'Gemini function call args must be a JSON object',
        retryable: false,
    });
}

function endpointForModel(baseEndpoint: string, modelID: string): string {
    const normalized = modelID.startsWith('models/') ? modelID : `models/${modelID}`;
    return `${baseEndpoint.replace(/\/$/, '')}/${normalized}:streamGenerateContent?alt=sse`;
}

function missingApiKeyError(providerID: string): ProviderTurnError {
    return new ProviderTurnError({
        code: 'provider_auth_failed',
        message: `provider credential for ${providerID} does not contain a Gemini API key`,
        retryable: false,
    });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected Gemini credential or message variant: ${JSON.stringify(value)}`);
}
