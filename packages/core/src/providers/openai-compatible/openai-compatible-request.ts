import type {
    ProviderCredential,
    ProviderCredentialField,
    ProviderToolCallTranscript,
    ToolDefinition,
} from '@mission-control/protocol';
import { ProviderCredentialResolutionError, type ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnError, type ProviderTurnRequest } from '../provider-turn-types.js';
import { type OpenAICompatibleProviderSpec, openAICompatibleProviderSpec } from './openai-compatible-specs.js';
import type {
    OpenAICompatibleChatMessage,
    OpenAICompatibleChatToolCall,
    OpenAICompatibleRequestBody,
    OpenAICompatibleTool,
    OpenAICompatibleTransportRequest,
} from './openai-compatible-transport.js';

export async function resolveOpenAICompatibleCredential(
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

export function createOpenAICompatibleTransportRequest(input: {
    readonly request: ProviderTurnRequest;
    readonly bearerToken: string;
    readonly signal: AbortSignal;
    readonly endpoint?: string;
}): OpenAICompatibleTransportRequest {
    const spec = requireOpenAICompatibleProviderSpec(input.request.providerID);
    return {
        endpoint: input.endpoint ?? spec.endpoint,
        signal: input.signal,
        headers: {
            Authorization: `Bearer ${input.bearerToken}`,
            'Content-Type': 'application/json',
        },
        body: createRequestBody(input.request, spec),
    };
}

export function bearerTokenForOpenAICompatibleCredential(credential: ProviderCredential): string {
    switch (credential.type) {
        case 'apiKey':
            return credential.apiKey;
        case 'oauth':
            return credential.accessToken;
        case 'fields': {
            const secretField = Object.values(credential.fields).find(isSecretCredentialField);
            if (secretField !== undefined) {
                return secretField.value;
            }
            throw new ProviderTurnError({
                code: 'provider_auth_failed',
                message: `provider credential for ${credential.providerID} does not contain a bearer token`,
                retryable: false,
            });
        }
        default:
            return assertNever(credential);
    }
}

function createRequestBody(
    request: ProviderTurnRequest,
    spec: OpenAICompatibleProviderSpec,
): OpenAICompatibleRequestBody {
    const tools = (request.tools ?? []).map(openAICompatibleToolForDefinition);
    if (tools.length > 0 && spec.unsupportedToolModelIDs?.includes(request.modelID) === true) {
        throw new ProviderTurnError({
            code: 'unknown',
            message: `${request.providerID}/${request.modelID} does not support tool calling`,
            retryable: false,
        });
    }
    return {
        model: request.modelID,
        messages: request.messages.map((message) => chatMessageForAgentMessage(message, request.providerID)),
        stream: true,
        ...(tools.length > 0 ? { tools } : {}),
    };
}

function chatMessageForAgentMessage(
    message: ProviderTurnRequest['messages'][number],
    providerID: string,
): OpenAICompatibleChatMessage {
    switch (message.role) {
        case 'system':
        case 'user':
            return { role: message.role, content: message.content };
        case 'assistant':
            return {
                role: 'assistant',
                content: message.content,
                ...toolCallsForAssistantMessage(message.providerToolCalls, providerID),
            };
        case 'tool':
            return {
                role: 'tool',
                tool_call_id: message.toolCallId,
                content: toolOutputForAgentMessage(message),
            };
        default:
            return assertNever(message);
    }
}

function toolCallsForAssistantMessage(
    providerToolCalls: readonly ProviderToolCallTranscript[] | undefined,
    providerID: string,
): { readonly tool_calls?: readonly OpenAICompatibleChatToolCall[] } {
    const toolCalls = (providerToolCalls ?? [])
        .filter((toolCall) => toolCall.providerID === providerID)
        .map((toolCall) => ({
            id: toolCall.providerCallId ?? toolCall.toolCallId,
            type: 'function' as const,
            function: {
                name: toolCall.toolName,
                arguments: toolCall.argumentsJson,
            },
        }));
    return toolCalls.length > 0 ? { tool_calls: toolCalls } : {};
}

function toolOutputForAgentMessage(
    message: Extract<ProviderTurnRequest['messages'][number], { readonly role: 'tool' }>,
): string {
    if (message.output !== undefined) {
        return message.output;
    }
    if (message.error !== undefined) {
        return `${message.error.code}: ${message.error.message}`;
    }
    return '';
}

function openAICompatibleToolForDefinition(tool: ToolDefinition): OpenAICompatibleTool {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parametersJsonSchema,
        },
    };
}

function requireOpenAICompatibleProviderSpec(providerID: string): OpenAICompatibleProviderSpec {
    const spec = openAICompatibleProviderSpec(providerID);
    if (spec !== undefined) {
        return spec;
    }
    throw new ProviderTurnError({
        code: 'unknown',
        message: `provider ${providerID} is not configured for the OpenAI-compatible adapter`,
        retryable: false,
    });
}

function isSecretCredentialField(field: ProviderCredentialField): boolean {
    return field.secret;
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected OpenAI-compatible value: ${JSON.stringify(value)}`);
}
