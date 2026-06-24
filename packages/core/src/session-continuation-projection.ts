import {
    type AgentEvent,
    type AgentMessage,
    AgentMessageSchema,
    type ProviderToolCallTranscript,
} from '@mission-control/protocol';

export type SequencedAgentMessage = {
    readonly message: AgentMessage;
    readonly sourceSequence: number;
};

export function projectApprovalContinuationMessages(
    events: readonly AgentEvent[],
    sessionId: string,
): readonly AgentMessage[] {
    return applyLatestCompaction(
        projectApprovalContinuationTranscript(events, sessionId),
        latestCompaction(events, sessionId),
    ).map((entry) => entry.message);
}

export function projectApprovalContinuationTranscript(
    events: readonly AgentEvent[],
    sessionId: string,
): readonly SequencedAgentMessage[] {
    const messages: SequencedAgentMessage[] = [];
    let currentToolCalls: ProviderToolCallTranscript[] = [];
    // Graph parity: the graph emits `tool.completed`/`tool.failed` DURING streamText (the bridge
    // runs tools inline), so those events arrive BEFORE the `model.call.completed` assistant
    // boundary. Buffering by toolCallId and flushing AFTER the matching assistant keeps the seed
    // conversation ordered `[user, assistant(tool_call), tool(result)]` the model expects.
    const pendingToolResults = new Map<string, SequencedAgentMessage>();

    events.forEach((event, sourceSequence) => {
        if (event.sessionId !== sessionId) {
            return;
        }
        if (event.type === 'model.call.started') {
            currentToolCalls = [];
        }
        appendPromptMessage(messages, event, sourceSequence);
        collectProviderToolCall(currentToolCalls, event);
        const appendedAssistant = appendAssistantMessage(messages, event, currentToolCalls, sourceSequence);
        bufferToolResultMessage(pendingToolResults, event, sourceSequence);
        if (appendedAssistant) {
            flushPendingToolResults(messages, pendingToolResults, currentToolCalls);
        }
    });
    // Trailing flush: a tool result emitted with no following assistant boundary (e.g. a
    // `run.blocked` after `tool.failed`) would otherwise stay buffered.
    flushAllPendingToolResults(messages, pendingToolResults);
    // Deduplicate tool messages by toolCallId, keeping the LATEST status. The desktop approval
    // flow writes a `tool.failed` (the original approval-block) followed by a `tool.completed`
    // (the out-of-band settlement after approval); the model needs only the final state.
    return deduplicateToolMessagesByToolCallId(messages);
}

function deduplicateToolMessagesByToolCallId(
    messages: readonly SequencedAgentMessage[],
): readonly SequencedAgentMessage[] {
    const lastIndexOfToolCallId = new Map<string, number>();
    messages.forEach((entry, index) => {
        if (entry.message.role === 'tool') {
            lastIndexOfToolCallId.set(entry.message.toolCallId, index);
        }
    });
    return messages.filter((entry, index) => {
        if (entry.message.role !== 'tool') {
            return true;
        }
        return lastIndexOfToolCallId.get(entry.message.toolCallId) === index;
    });
}

export function hasPendingDesktopApprovals(events: readonly AgentEvent[], sessionId: string): boolean {
    const approvalStates = new Map<string, string>();
    for (const event of events) {
        if (event.sessionId !== sessionId || event.approvalRecord === undefined) {
            continue;
        }
        approvalStates.set(event.approvalRecord.approvalId, event.approvalRecord.state);
    }
    return [...approvalStates.values()].some((state) => state === 'pending');
}

function appendPromptMessage(messages: SequencedAgentMessage[], event: AgentEvent, sourceSequence: number): void {
    if (event.type !== 'prompt.promoted') {
        return;
    }
    messages.push({
        message: AgentMessageSchema.parse({
            role: 'user',
            content: event.message ?? '',
        }),
        sourceSequence,
    });
}

function collectProviderToolCall(toolCalls: ProviderToolCallTranscript[], event: AgentEvent): void {
    const chunk = event.providerStreamChunk;
    if (chunk?.kind === 'tool_call_completed') {
        toolCalls.push({
            providerID: event.modelProviderSelection?.providerID ?? 'unknown',
            toolCallId: chunk.toolCall.toolCallId,
            toolName: chunk.toolCall.toolName,
            argumentsJson: chunk.toolCall.argumentsJson,
        });
        return;
    }
    collectGraphToolCall(toolCalls, event);
}

/**
 * Graph parity for the flat `tool_call_completed` chunk: the ABG graph emits tool-call proposals as
 * `abg.emit.type === 'llm.tool_call.proposed'` on a `log` event, with parsed `input` JSON-stringified
 * back into `argumentsJson`. Narrowed `in`/`typeof` (no casts).
 */
function collectGraphToolCall(toolCalls: ProviderToolCallTranscript[], event: AgentEvent): void {
    const emit = event.abg?.emit;
    if (emit === undefined || emit.type !== 'llm.tool_call.proposed') {
        return;
    }
    const payload = emit.payload;
    if (typeof payload !== 'object' || payload === null) {
        return;
    }
    if (!('toolCallId' in payload) || typeof payload.toolCallId !== 'string') {
        return;
    }
    if (!('toolName' in payload) || typeof payload.toolName !== 'string') {
        return;
    }
    const toolCallId = payload.toolCallId;
    const toolName = payload.toolName;
    const input = 'input' in payload ? payload.input : undefined;
    toolCalls.push({
        providerID: event.modelProviderSelection?.providerID ?? 'unknown',
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(input ?? {}),
    });
}

function appendAssistantMessage(
    messages: SequencedAgentMessage[],
    event: AgentEvent,
    currentToolCalls: readonly ProviderToolCallTranscript[],
    sourceSequence: number,
): boolean {
    const chunk = event.providerStreamChunk;
    if (chunk?.kind === 'response_completed') {
        const providerToolCalls = chunk.message.providerToolCalls ?? currentToolCalls;
        messages.push({
            message: AgentMessageSchema.parse({
                role: 'assistant',
                content: chunk.message.content,
                ...(providerToolCalls.length > 0 ? { providerToolCalls: [...providerToolCalls] } : {}),
            }),
            sourceSequence,
        });
        return true;
    }
    return appendGraphAssistantMessage(messages, event, currentToolCalls, sourceSequence);
}

/**
 * Graph parity for the flat `response_completed` chunk. The graph surfaces an LLM turn's final text
 * via `model.call.completed.message` (set by `modelCallEvent` from the `llm.turn.completed`
 * payload). When the LLMActor short-circuited (approval block), the event carries the synthetic
 * label `'model.call.completed: <nodeId>'` and no real text — synthesize an empty assistant turn
 * carrying the proposed tool calls so resume seeds `[user, assistant(tool_call), tool(result)]`.
 */
function appendGraphAssistantMessage(
    messages: SequencedAgentMessage[],
    event: AgentEvent,
    currentToolCalls: readonly ProviderToolCallTranscript[],
    sourceSequence: number,
): boolean {
    // Only graph-style `model.call.completed` events carry abg metadata (graphId/nodeId/emit).
    // Flat-path events with the same type would otherwise be misread as graph final-text carriers.
    if (event.abg === undefined || event.type !== 'model.call.completed' || event.message === undefined) {
        return false;
    }
    if (event.message.startsWith('model.call.completed:')) {
        if (currentToolCalls.length > 0) {
            messages.push({
                message: AgentMessageSchema.parse({
                    role: 'assistant',
                    content: '',
                    ...(currentToolCalls.length > 0 ? { providerToolCalls: [...currentToolCalls] } : {}),
                }),
                sourceSequence,
            });
            return true;
        }
        return false;
    }
    messages.push({
        message: AgentMessageSchema.parse({
            role: 'assistant',
            content: event.message,
            ...(currentToolCalls.length > 0 ? { providerToolCalls: [...currentToolCalls] } : {}),
        }),
        sourceSequence,
    });
    return true;
}

function appendToolResultMessage(messages: SequencedAgentMessage[], event: AgentEvent, sourceSequence: number): void {
    const buffered = bufferToolResultEntry(event, sourceSequence);
    if (buffered === undefined) {
        return;
    }
    messages.push(buffered);
}

function bufferToolResultMessage(
    pending: Map<string, SequencedAgentMessage>,
    event: AgentEvent,
    sourceSequence: number,
): void {
    const buffered = bufferToolResultEntry(event, sourceSequence);
    if (buffered !== undefined && buffered.message.role === 'tool') {
        pending.set(buffered.message.toolCallId, buffered);
    }
}

function bufferToolResultEntry(event: AgentEvent, sourceSequence: number): SequencedAgentMessage | undefined {
    if (event.toolResult === undefined) {
        return undefined;
    }
    return {
        message: AgentMessageSchema.parse({
            role: 'tool',
            toolCallId: event.toolResult.toolCallId,
            status: event.toolResult.status,
            ...(event.toolResult.output !== undefined ? { output: event.toolResult.output } : {}),
            // A `failed` result MUST carry an `error` (the schema's `superRefine` rejects one
            // without). Persisted tool results normally attach one; harden the boundary so a
            // failed result replayed from an older/oddly-shaped event cannot throw here.
            ...(event.toolResult.error !== undefined
                ? { error: event.toolResult.error }
                : event.toolResult.status === 'failed'
                  ? { error: { code: 'tool_failed', message: 'tool failed', retryable: false } }
                  : {}),
            ...(event.toolResult.redactions !== undefined ? { redactions: event.toolResult.redactions } : {}),
        }),
        sourceSequence,
    };
}

function flushPendingToolResults(
    messages: SequencedAgentMessage[],
    pending: Map<string, SequencedAgentMessage>,
    currentToolCalls: readonly ProviderToolCallTranscript[],
): void {
    if (currentToolCalls.length === 0 || pending.size === 0) {
        return;
    }
    for (const call of currentToolCalls) {
        const buffered = pending.get(call.toolCallId);
        if (buffered !== undefined) {
            messages.push(buffered);
            pending.delete(call.toolCallId);
        }
    }
}

function flushAllPendingToolResults(
    messages: SequencedAgentMessage[],
    pending: Map<string, SequencedAgentMessage>,
): void {
    for (const buffered of pending.values()) {
        messages.push(buffered);
    }
    pending.clear();
}

type LatestCompaction = {
    readonly boundarySequence: number;
    readonly compactionSequence: number;
    readonly firstKeptSequence: number;
    readonly summary: string;
};

function latestCompaction(events: readonly AgentEvent[], sessionId: string): LatestCompaction | undefined {
    let latest: LatestCompaction | undefined;
    events.forEach((event, compactionSequence) => {
        if (event.sessionId !== sessionId || !isCompleteCompactionBoundary(event.sessionTree)) {
            return;
        }
        latest = {
            boundarySequence: event.sessionTree.boundarySequence,
            compactionSequence,
            firstKeptSequence: event.sessionTree.firstKeptSequence,
            summary: event.sessionTree.summary,
        };
    });
    return latest;
}

function applyLatestCompaction(
    transcript: readonly SequencedAgentMessage[],
    compaction: LatestCompaction | undefined,
): readonly SequencedAgentMessage[] {
    if (compaction === undefined) {
        return transcript;
    }
    const retained = transcript.filter(
        (entry) =>
            (entry.sourceSequence >= compaction.firstKeptSequence &&
                entry.sourceSequence <= compaction.boundarySequence) ||
            entry.sourceSequence > compaction.compactionSequence,
    );
    return [
        {
            message: AgentMessageSchema.parse({
                role: 'user',
                content: `Session memory summary (untrusted, model-generated):\n${compaction.summary}`,
            }),
            sourceSequence: compaction.compactionSequence,
        },
        ...retained,
    ];
}

function isCompleteCompactionBoundary(value: unknown): value is {
    readonly kind: 'compaction';
    readonly summary: string;
    readonly boundarySequence: number;
    readonly firstKeptSequence: number;
} {
    return (
        isRecord(value) &&
        value.kind === 'compaction' &&
        typeof value.summary === 'string' &&
        typeof value.boundarySequence === 'number' &&
        typeof value.firstKeptSequence === 'number'
    );
}

type CompactionBoundaryCandidate = {
    readonly kind?: unknown;
    readonly summary?: unknown;
    readonly boundarySequence?: unknown;
    readonly firstKeptSequence?: unknown;
};

function isRecord(value: unknown): value is CompactionBoundaryCandidate {
    return typeof value === 'object' && value !== null;
}
