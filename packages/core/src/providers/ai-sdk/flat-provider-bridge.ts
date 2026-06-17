/**
 * Flat-provider → AI-SDK bridge (Phase 5 / flip-default enabler).
 *
 * The coding-agent GRAPH engine drives providers through the Vercel AI SDK: the graph's LLMActor
 * node calls `streamText`, which calls `LanguageModelV3.doStream`. Real providers get an AI-SDK
 * model from `model-resolver.ts`. But the flat engine's providers are `ProviderAdapter`s
 * (`streamTurn(request) → AsyncIterable<ProviderStreamChunk>`) — a different shape the SDK can't
 * call directly. The CLI's non-interactive test suite injects those flat providers via
 * `runAgent({ provider })`, and the graph path used to ignore the injection (resolving a real
 * provider from the auth store instead → network → timeout). That blocked the blanket flip.
 *
 * This bridge wraps a flat `ProviderAdapter` AS a `LanguageModelV3` so the graph engine can drive
 * the SAME injected flat provider the flat engine would: it converts the SDK's standardized
 * message list + tool list into a flat `ProviderTurnRequest`, drives `streamTurn`, and translates
 * the resulting `ProviderStreamChunk` stream back into `LanguageModelV3StreamPart`s. So an
 * injected deterministic/local-echo provider runs unchanged on the graph engine — no per-test
 * rewrite — which lets the flip-default run the credential-free flat-path tests on the graph to
 * verify engine parity.
 *
 * Deliberate scope: this is a faithful transport adapter, not a full flat→graph event parity
 * layer. Run-lifecycle machine state (run.failed/run.interrupted/session.stopped) is owned by the
 * session run owner the graph turn runner shares with the flat path; redaction, replay event
 * vocabulary, and interrupted-vs-failed error-code preservation are separate parity concerns.
 */
import {
    type JSONSchema7,
    type LanguageModelV3,
    type LanguageModelV3CallOptions,
    type LanguageModelV3FunctionTool,
    type LanguageModelV3Message,
    type LanguageModelV3ProviderTool,
    type LanguageModelV3StreamPart,
    type LanguageModelV3TextPart,
    type LanguageModelV3ToolCallPart,
    type LanguageModelV3ToolResultPart,
    type LanguageModelV3Usage,
    UnsupportedFunctionalityError,
} from '@ai-sdk/provider';
import type {
    AgentMessage,
    ProtocolError,
    ProviderFinishReason,
    ProviderStreamChunk,
    ProviderUsage,
    ToolDefinition,
} from '@mission-control/protocol';
import { type ProviderAdapter, type ProviderAdapterContext, type ProviderTurnRequest } from '../provider-turn-types.js';

export type FlatProviderBridgeOptions = {
    readonly provider: ProviderAdapter;
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionId?: string;
};

/**
 * Surfaced through the stream when a flat provider yields `response_failed`. Carries the original
 * `ProtocolError` (code + retryable) so downstream graph→coordinator mapping can distinguish an
 * abort (`provider_aborted`) from a hard failure the way the flat run coordinator does.
 */
export class FlatProviderBridgeError extends Error {
    readonly name = 'FlatProviderBridgeError';
    readonly error: ProtocolError;

    constructor(error: ProtocolError) {
        super(error.message);
        this.error = error;
    }
}

/**
 * Wrap a flat `ProviderAdapter` as an AI-SDK `LanguageModelV3`. The graph's `streamText` call
 * drives `doStream`, which runs one flat `streamTurn` against the (injected) provider and
 * re-encodes the chunk stream for the SDK. `doGenerate` is unsupported — the graph path only
 * streams.
 */
export function wrapFlatProviderAsSdkModel(options: FlatProviderBridgeOptions): LanguageModelV3 {
    const provider = options.provider;
    const providerID = options.providerID;
    const modelID = options.modelID;
    return {
        specificationVersion: 'v3',
        provider: providerID,
        modelId: modelID,
        supportedUrls: {},
        async doGenerate() {
            throw new UnsupportedFunctionalityError({
                functionality: 'flat-provider-bridge doGenerate',
                message: 'the flat-provider bridge drives streamTurn (the graph path uses doStream)',
            });
        },
        async doStream(callOptions: LanguageModelV3CallOptions) {
            const request: ProviderTurnRequest = {
                requestId: `flat_bridge_${nextRequestId()}`,
                sessionId: options.sessionId ?? 'flat-provider-bridge',
                turnId: `flat_bridge_turn_${nextTurnId()}`,
                providerID,
                modelID,
                ...(options.variantID !== undefined ? { variantID: options.variantID } : {}),
                messages: sdkPromptToAgentMessages(callOptions.prompt),
                ...(callOptions.tools !== undefined ? { tools: sdkToolsToToolDefinitions(callOptions.tools) } : {}),
            };
            const context: ProviderAdapterContext = {
                attempt: 1,
                signal: callOptions.abortSignal ?? new AbortController().signal,
            };
            return { stream: bridgeFlatStream(provider.streamTurn(request, context)) };
        },
    };
}

/**
 * Convert the SDK's standardized message list into the flat engine's `AgentMessage[]`. Text-bearing
 * roles keep their concatenated text; assistant tool-call parts become `providerToolCalls`
 * transcripts; SDK tool messages (which bundle multiple results per message) are flattened into one
 * `role: 'tool'` message per result — the shape the flat providers and run coordinator expect.
 */
function sdkPromptToAgentMessages(prompt: readonly LanguageModelV3Message[]): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (const message of prompt) {
        if (message.role === 'system') {
            messages.push({ role: 'system', content: message.content });
        } else if (message.role === 'user') {
            messages.push({ role: 'user', content: textOf(message.content) });
        } else if (message.role === 'assistant') {
            const transcripts = toolCallTranscriptsOf(message.content);
            messages.push({
                role: 'assistant',
                content: textOf(message.content),
                ...(transcripts.length > 0 ? { providerToolCalls: transcripts } : {}),
            });
        } else if (message.role === 'tool') {
            for (const part of message.content) {
                if (part.type === 'tool-result') {
                    messages.push(toolResultToAgentMessage(part));
                }
            }
        }
    }
    return messages;
}

function textOf<P extends { readonly type: string }>(content: ReadonlyArray<P>): string {
    return content
        .filter((part): part is P & LanguageModelV3TextPart => part.type === 'text')
        .map((part) => part.text)
        .join('');
}

function toolCallTranscriptsOf<P extends { readonly type: string }>(
    content: ReadonlyArray<P>,
): NonNullable<Extract<AgentMessage, { readonly role: 'assistant' }>['providerToolCalls']> {
    return content
        .filter((part): part is Extract<P, LanguageModelV3ToolCallPart> => part.type === 'tool-call')
        .map((part) => ({
            providerID: 'flat-bridge',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            argumentsJson: JSON.stringify(part.input),
        }));
}

function toolResultToAgentMessage(part: LanguageModelV3ToolResultPart): AgentMessage {
    const output = toolResultOutputToText(part.output);
    const outputKind = part.output.type;
    if (outputKind === 'execution-denied' || outputKind === 'error-text' || outputKind === 'error-json') {
        return {
            role: 'tool',
            toolCallId: part.toolCallId,
            status: 'failed',
            error: {
                code: 'unknown',
                message: output.length > 0 ? output : `tool ${part.toolName} failed`,
                retryable: false,
            },
        };
    }
    return {
        role: 'tool',
        toolCallId: part.toolCallId,
        status: 'completed',
        ...(output.length > 0 ? { output } : {}),
    };
}

function toolResultOutputToText(output: LanguageModelV3ToolResultPart['output']): string {
    switch (output.type) {
        case 'text':
            return output.value;
        case 'error-text':
            return output.value;
        case 'json':
        case 'error-json':
            return JSON.stringify(output.value);
        case 'content':
            return output.value
                .filter((entry) => entry.type === 'text')
                .map((entry) => (entry.type === 'text' ? entry.text : ''))
                .join('');
        case 'execution-denied':
            return output.reason ?? `tool execution denied`;
        default:
            return assertNeverOutput(output);
    }
}

function assertNeverOutput(value: never): string {
    return `unsupported tool result output: ${JSON.stringify(value)}`;
}

function sdkToolsToToolDefinitions(
    tools: ReadonlyArray<LanguageModelV3FunctionTool | LanguageModelV3ProviderTool> | undefined,
): readonly ToolDefinition[] {
    if (tools === undefined) {
        return [];
    }
    return tools
        .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === 'function')
        .map((tool) => ({
            name: tool.name,
            description: tool.description ?? tool.name,
            parametersJsonSchema: jsonSchemaToRecord(tool.inputSchema),
        }));
}

/** Round-trip a JSON schema into a plain record (the flat `parametersJsonSchema` shape). */
function jsonSchemaToRecord(schema: JSONSchema7): Record<string, unknown> {
    const record: Record<string, unknown> = JSON.parse(JSON.stringify(schema));
    return record;
}

/**
 * Translate a flat `ProviderStreamChunk` async iterable into a `LanguageModelV3StreamPart` stream.
 * Text deltas are framed with text-start/text-end; tool calls are emitted in full on
 * `tool_call_completed` (the flat stream only carries the toolName there, so the input deltas are
 * emitted as one block); `response_completed` becomes the terminal `finish`. `response_failed`
 * surfaces through `controller.error` as a `FlatProviderBridgeError` carrying the original
 * `ProtocolError` so the abort/fail distinction is preserved for downstream mapping.
 */
function bridgeFlatStream(chunks: AsyncIterable<ProviderStreamChunk>): ReadableStream<LanguageModelV3StreamPart> {
    return new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
            const textId = 'flat_bridge_text';
            let textOpen = false;
            let textEmitted = false;
            const closeText = () => {
                if (textOpen) {
                    controller.enqueue({ type: 'text-end', id: textId });
                    textOpen = false;
                }
            };
            controller.enqueue({ type: 'stream-start', warnings: [] });
            try {
                for await (const chunk of chunks) {
                    switch (chunk.kind) {
                        case 'response_started':
                            break;
                        case 'text_delta':
                            if (!textOpen) {
                                controller.enqueue({ type: 'text-start', id: textId });
                                textOpen = true;
                            }
                            controller.enqueue({ type: 'text-delta', id: textId, delta: chunk.delta });
                            textEmitted = true;
                            break;
                        case 'tool_call_delta':
                            // Buffered — emitted in full on the matching `tool_call_completed`
                            // (the flat stream only carries the toolName on completion).
                            break;
                        case 'tool_call_completed': {
                            closeText();
                            const { toolCallId, toolName, argumentsJson } = chunk.toolCall;
                            controller.enqueue({ type: 'tool-input-start', id: toolCallId, toolName });
                            controller.enqueue({ type: 'tool-input-delta', id: toolCallId, delta: argumentsJson });
                            controller.enqueue({ type: 'tool-input-end', id: toolCallId });
                            controller.enqueue({ type: 'tool-call', toolCallId, toolName, input: argumentsJson });
                            break;
                        }
                        case 'response_completed': {
                            closeText();
                            // Deterministic/scripted providers (and any provider that delivers the
                            // full assistant text on completion rather than via text_delta) carry the
                            // final content on the response message. Surface it as a text block when
                            // nothing was streamed so the SDK's result.text — and the turn's
                            // final-text event — carry the model's actual output, matching the flat
                            // loop (which reads message.content directly).
                            if (!textEmitted) {
                                const content = chunk.message?.content;
                                if (typeof content === 'string' && content.length > 0) {
                                    controller.enqueue({ type: 'text-start', id: textId });
                                    controller.enqueue({ type: 'text-delta', id: textId, delta: content });
                                    controller.enqueue({ type: 'text-end', id: textId });
                                }
                            }
                            controller.enqueue(finishStreamPart(chunk.finishReason, chunk.usage));
                            break;
                        }
                        case 'response_failed':
                            closeText();
                            controller.enqueue(finishStreamPart('error', undefined));
                            controller.error(new FlatProviderBridgeError(chunk.error));
                            return;
                        default:
                            return assertNeverChunk(chunk);
                    }
                }
            } catch (error: unknown) {
                controller.error(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            controller.close();
        },
    });
}

function assertNeverChunk(value: never): never {
    throw new TypeError(`unexpected provider stream chunk: ${JSON.stringify(value)}`);
}

function finishStreamPart(
    reason: ProviderFinishReason | 'error',
    usage: ProviderUsage | undefined,
): LanguageModelV3StreamPart {
    return {
        type: 'finish',
        finishReason: { unified: mapFinishReason(reason), raw: undefined },
        usage: mapUsage(usage),
    };
}

function mapFinishReason(reason: ProviderFinishReason | 'error'): 'stop' | 'tool-calls' {
    return reason === 'tool_calls' ? 'tool-calls' : 'stop';
}

function mapUsage(usage: ProviderUsage | undefined): LanguageModelV3Usage {
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    return {
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output, reasoning: 0 },
    };
}

let nextRequestIdCounter = 1;
let nextTurnIdCounter = 1;

function nextRequestId(): number {
    const value = nextRequestIdCounter;
    nextRequestIdCounter += 1;
    return value;
}

function nextTurnId(): number {
    const value = nextTurnIdCounter;
    nextTurnIdCounter += 1;
    return value;
}
