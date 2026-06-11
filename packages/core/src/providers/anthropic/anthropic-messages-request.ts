import type { AgentMessage, ProviderCredential, ToolDefinition } from '@mission-control/protocol';
import { ProviderCredentialResolutionError, type ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnError, type ProviderTurnRequest } from '../provider-turn-types.js';
import {
    type AnthropicContentBlock,
    type AnthropicMessagesRequestBody,
    type AnthropicMessagesTransportRequest,
    type AnthropicRequestMessage,
    type AnthropicToolDefinition,
    type AnthropicToolResultContentBlock,
    defaultAnthropicMaxTokens,
    defaultAnthropicMessagesEndpoint,
    defaultAnthropicVersion,
} from './anthropic-messages-transport.js';

const API_KEY_FIELD = 'apiKey';

export async function resolveAnthropicCredential(
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

export function createAnthropicMessagesTransportRequest(input: {
    readonly request: ProviderTurnRequest;
    readonly apiKey: string;
    readonly signal: AbortSignal;
    readonly endpoint?: string;
}): AnthropicMessagesTransportRequest {
    return {
        endpoint: input.endpoint ?? defaultAnthropicMessagesEndpoint,
        signal: input.signal,
        headers: {
            'x-api-key': input.apiKey,
            'anthropic-version': defaultAnthropicVersion,
            'Content-Type': 'application/json',
        },
        body: createRequestBody(input.request),
    };
}

export function apiKeyForAnthropicCredential(credential: ProviderCredential): string {
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

function createRequestBody(request: ProviderTurnRequest): AnthropicMessagesRequestBody {
    const system = systemPromptFromMessages(request.messages);
    const messages = anthropicMessagesFromAgentMessages(request.messages);
    const tools = (request.tools ?? []).map(anthropicToolForDefinition);
    return {
        model: request.modelID,
        max_tokens: defaultAnthropicMaxTokens,
        stream: true,
        ...(system !== undefined ? { system } : {}),
        messages,
        ...(tools.length > 0 ? { tools } : {}),
    };
}

function systemPromptFromMessages(messages: readonly AgentMessage[]): string | undefined {
    const systemPrompts = messages.filter((message) => message.role === 'system').map((message) => message.content);
    return systemPrompts.length === 0 ? undefined : systemPrompts.join('\n\n');
}

function anthropicMessagesFromAgentMessages(messages: readonly AgentMessage[]): readonly AnthropicRequestMessage[] {
    const output: AnthropicRequestMessage[] = [];
    let index = 0;
    while (index < messages.length) {
        const message = messages[index];
        if (message === undefined) {
            index += 1;
            continue;
        }
        if (message.role === 'tool') {
            const grouped = groupedToolResults(messages, index);
            output.push({ role: 'user', content: grouped.blocks });
            index = grouped.nextIndex;
            continue;
        }
        const mapped = anthropicMessageFromTextMessage(message);
        if (mapped !== undefined) {
            output.push(mapped);
        }
        index += 1;
    }
    return output;
}

function groupedToolResults(
    messages: readonly AgentMessage[],
    startIndex: number,
): { readonly blocks: readonly AnthropicToolResultContentBlock[]; readonly nextIndex: number } {
    const blocks: AnthropicToolResultContentBlock[] = [];
    let index = startIndex;
    while (index < messages.length) {
        const message = messages[index];
        if (message?.role !== 'tool') {
            break;
        }
        blocks.push(anthropicToolResultForAgentMessage(message));
        index += 1;
    }
    return { blocks, nextIndex: index };
}

function anthropicMessageFromTextMessage(
    message: Exclude<AgentMessage, { readonly role: 'tool' }>,
): AnthropicRequestMessage | undefined {
    switch (message.role) {
        case 'system':
            return undefined;
        case 'user':
            return { role: 'user', content: message.content };
        case 'assistant': {
            const toolBlocks = (message.providerToolCalls ?? [])
                .filter((toolCall) => toolCall.providerID === 'anthropic')
                .map((toolCall) => ({
                    type: 'tool_use' as const,
                    id: toolCall.providerCallId ?? toolCall.toolCallId,
                    name: toolCall.toolName,
                    input: parseToolInput(toolCall.argumentsJson),
                }));
            if (toolBlocks.length === 0) {
                return { role: 'assistant', content: message.content };
            }
            const content: AnthropicContentBlock[] = [
                ...(message.content.length > 0 ? [{ type: 'text' as const, text: message.content }] : []),
                ...toolBlocks,
            ];
            return { role: 'assistant', content };
        }
        default:
            return assertNever(message);
    }
}

function anthropicToolResultForAgentMessage(
    message: Extract<AgentMessage, { readonly role: 'tool' }>,
): AnthropicToolResultContentBlock {
    if (message.status === 'failed') {
        return {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.error === undefined ? 'tool failed' : `${message.error.code}: ${message.error.message}`,
            is_error: true,
        };
    }
    return message.output === undefined
        ? { type: 'tool_result', tool_use_id: message.toolCallId }
        : { type: 'tool_result', tool_use_id: message.toolCallId, content: message.output };
}

function anthropicToolForDefinition(tool: ToolDefinition): AnthropicToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.parametersJsonSchema,
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
                message: `Anthropic tool input is not valid JSON: ${error.message}`,
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
        message: 'Anthropic tool input must be a JSON object',
        retryable: false,
    });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingApiKeyError(providerID: string): ProviderTurnError {
    return new ProviderTurnError({
        code: 'provider_auth_failed',
        message: `provider credential for ${providerID} does not contain an Anthropic API key`,
        retryable: false,
    });
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected Anthropic credential or message variant: ${JSON.stringify(value)}`);
}
