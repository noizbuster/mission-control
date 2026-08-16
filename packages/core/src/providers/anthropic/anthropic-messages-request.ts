import type { AgentMessage, ProviderCredential, ToolDefinition } from '@mission-control/protocol';
import { ProviderTurnError, type ProviderTurnRequest } from '../provider-turn-types';
import { parseJsonObjectToolInput } from '../shared/provider-helpers';
import { SHARED_VARIANT_LOOKUP } from '../shared/variant-cache';
import {
    type AnthropicContentBlock,
    type AnthropicMessagesRequestBody,
    type AnthropicMessagesTransportRequest,
    type AnthropicRequestMessage,
    type AnthropicSystemTextBlock,
    type AnthropicThinkingConfig,
    type AnthropicToolDefinition,
    type AnthropicToolResultContentBlock,
    defaultAnthropicMaxTokens,
    defaultAnthropicMessagesEndpoint,
    defaultAnthropicVersion,
} from './anthropic-messages-transport';

const API_KEY_FIELD = 'apiKey';

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
    const mapped = anthropicThinkingForVariant(request.modelID, request.variantID);
    return {
        model: request.modelID,
        max_tokens: mapped?.max_tokens ?? defaultAnthropicMaxTokens,
        stream: true,
        ...(system !== undefined ? { system: cachedSystemBlocks(system) } : {}),
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(mapped?.thinking !== undefined ? { thinking: mapped.thinking } : {}),
    };
}

/**
 * The system prompt is stable for the life of a session, so mark it as an ephemeral prompt-cache
 * breakpoint (tools + system prefix). Prompts under Anthropic's minimum cacheable prefix are
 * processed without caching — marking is always safe. Matches the cacheControl intent the
 * llm-actor sets for the official @ai-sdk/anthropic path; this is the flat-adapter equivalent
 * (the flat bridge drops message-level providerOptions, so caching must live here).
 */
function cachedSystemBlocks(system: string): readonly AnthropicSystemTextBlock[] {
    return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

function anthropicThinkingForVariant(
    modelID: string,
    variantID: string | undefined,
): { readonly thinking: AnthropicThinkingConfig; readonly max_tokens: number } | undefined {
    if (variantID === undefined || !isConfiguredAnthropicVariant(modelID, variantID)) {
        return undefined;
    }
    switch (variantID) {
        case 'thinking-low':
            return { thinking: { type: 'enabled', budget_tokens: 8000 }, max_tokens: 9024 };
        case 'thinking-medium':
            return { thinking: { type: 'enabled', budget_tokens: 16000 }, max_tokens: 17024 };
        case 'thinking-high':
            return { thinking: { type: 'enabled', budget_tokens: 32000 }, max_tokens: 33024 };
        case 'thinking-off':
            return undefined;
        default:
            return undefined;
    }
}

function isConfiguredAnthropicVariant(modelID: string, variantID: string): boolean {
    return SHARED_VARIANT_LOOKUP('anthropic', modelID, variantID);
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

const parseToolInput = parseJsonObjectToolInput('Anthropic tool input');

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
