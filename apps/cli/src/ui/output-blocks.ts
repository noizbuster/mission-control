import type { AgentEvent, ToolResult } from '@mission-control/protocol';

export type SessionHeaderBlock = {
    kind: 'session-header';
    providerID: string;
    modelID: string;
    variantID?: string;
};

export type AssistantTextBlock = {
    kind: 'assistant-text';
    text: string;
};

export type ReasoningBlock = {
    kind: 'reasoning';
    text: string;
};

export type ToolBlockStatus = 'completed' | 'failed' | 'pending';

export type ToolErrorPayload = {
    code: string;
    message: string;
};

export type ToolBlock = {
    kind: 'tool';
    toolCallId: string;
    toolName: string;
    argumentsJson: string;
    status: ToolBlockStatus;
    output?: string;
    error?: ToolErrorPayload;
};

export type ErrorBlock = {
    kind: 'error';
    message: string;
};

export type OutputBlock =
    | SessionHeaderBlock
    | AssistantTextBlock
    | ReasoningBlock
    | ToolBlock
    | ErrorBlock;

interface DeltaEntry {
    openSeq: number;
    deltas: Array<{ sequence: number; delta: string }>;
}

interface OpenToolEntry {
    openSeq: number;
    toolName: string;
    argumentsJson: string;
    output?: string;
    error?: ToolErrorPayload;
}

export interface BlockAccumulator {
    consume(event: AgentEvent): readonly OutputBlock[];
    flush(): readonly OutputBlock[];
}

export function foldEvents(events: readonly AgentEvent[]): readonly OutputBlock[] {
    const acc = createBlockAccumulator();
    const out: OutputBlock[] = [];
    for (const e of events) {
        out.push(...acc.consume(e));
    }
    out.push(...acc.flush());
    return out;
}

export function createBlockAccumulator(): BlockAccumulator {
    let sessionHeaderEmitted = false;
    let openSeqCounter = 0;
    const toolNames = new Map<string, string>();
    const openText = new Map<string, DeltaEntry>();
    const openReasoning = new Map<string, DeltaEntry>();
    const openTools = new Map<string, OpenToolEntry>();

    const nextSeq = (): number => {
        openSeqCounter += 1;
        return openSeqCounter;
    };

    const appendDelta = (store: Map<string, DeltaEntry>, requestId: string, sequence: number, delta: string): void => {
        const existing = store.get(requestId);
        if (existing !== undefined) {
            existing.deltas.push({ sequence, delta });
            return;
        }
        store.set(requestId, { openSeq: nextSeq(), deltas: [{ sequence, delta }] });
    };

    const consume = (event: AgentEvent): readonly OutputBlock[] => {
        const out: OutputBlock[] = [];
        const chunk = event.providerStreamChunk;

        if (!sessionHeaderEmitted && event.modelProviderSelection !== undefined) {
            const sel = event.modelProviderSelection;
            sessionHeaderEmitted = true;
            out.push({
                kind: 'session-header',
                providerID: sel.providerID,
                modelID: sel.modelID,
                ...(sel.variantID !== undefined ? { variantID: sel.variantID } : {}),
            });
        }

        if (chunk?.kind === 'text_delta') {
            appendDelta(openText, chunk.requestId, chunk.sequence, chunk.delta);
        }
        if (chunk?.kind === 'reasoning_delta') {
            appendDelta(openReasoning, chunk.requestId, chunk.sequence, chunk.delta);
        }
        if (chunk?.kind === 'reasoning_completed') {
            openReasoning.delete(chunk.requestId);
            out.push({ kind: 'reasoning', text: chunk.text });
        }
        if (chunk?.kind === 'tool_call_completed') {
            const { toolCallId, toolName, argumentsJson } = chunk.toolCall;
            toolNames.set(toolCallId, toolName);
            if (!openTools.has(toolCallId)) {
                openTools.set(toolCallId, { openSeq: nextSeq(), toolName, argumentsJson });
            }
        }
        if (chunk?.kind === 'response_completed') {
            const requestId = chunk.requestId;
            const openReason = openReasoning.get(requestId);
            if (openReason !== undefined) {
                openReasoning.delete(requestId);
                out.push({
                    kind: 'reasoning',
                    text: chunk.message.reasoning ?? joinDeltas(openReason.deltas),
                });
            } else if (chunk.message.reasoning !== undefined && chunk.message.reasoning.length > 0) {
                out.push({ kind: 'reasoning', text: chunk.message.reasoning });
            }
            openText.delete(requestId);
            out.push({ kind: 'assistant-text', text: chunk.message.content });
        }

        // Graph path: model.call.completed carries the final assistant text in event.message
        // when no providerStreamChunk accompanies it (the common case for the non-interactive
        // graph path with the local provider or non-streaming adapters). Skip when a
        // response_completed chunk already produced assistant-text from the same event,
        // and skip the generic "model.call.completed: <nodeId>" label emitted when finalText
        // was unavailable.
        if (
            event.type === 'model.call.completed' &&
            chunk === undefined &&
            event.message !== undefined &&
            event.message.length > 0 &&
            !isGenericModelCallLabel(event)
        ) {
            out.push({ kind: 'assistant-text', text: event.message });
        }

        if (event.toolResult !== undefined) {
            out.push(closeTool(event.toolResult));
        }

        if (chunk?.kind === 'response_failed') {
            out.push({ kind: 'error', message: chunk.error.message });
        }
        const isBareFailureType =
            event.type === 'run.failed' ||
            event.type === 'task.failed' ||
            (event.type === 'tool.failed' && event.toolResult === undefined);
        if (isBareFailureType) {
            out.push({ kind: 'error', message: errorMessageFor(event) });
        }

        return out;
    };

    const closeTool = (result: ToolResult): ToolBlock => {
        const id = result.toolCallId;
        const entry = openTools.get(id);
        const toolName = entry?.toolName ?? toolNames.get(id) ?? 'unknown';
        const argumentsJson = entry?.argumentsJson ?? '';
        openTools.delete(id);
        const status: ToolBlockStatus = result.status === 'completed' ? 'completed' : 'failed';
        const error: ToolErrorPayload | undefined =
            result.error !== undefined ? { code: result.error.code, message: result.error.message } : undefined;
        return {
            kind: 'tool',
            toolCallId: id,
            toolName,
            argumentsJson,
            status,
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(error !== undefined ? { error } : {}),
        };
    };

    const flush = (): readonly OutputBlock[] => {
        const pending: Array<{ openSeq: number; block: OutputBlock }> = [];
        for (const entry of openReasoning.values()) {
            pending.push({ openSeq: entry.openSeq, block: { kind: 'reasoning', text: joinDeltas(entry.deltas) } });
        }
        openReasoning.clear();
        for (const entry of openText.values()) {
            pending.push({ openSeq: entry.openSeq, block: { kind: 'assistant-text', text: joinDeltas(entry.deltas) } });
        }
        openText.clear();
        for (const [toolCallId, entry] of openTools) {
            pending.push({
                openSeq: entry.openSeq,
                block: {
                    kind: 'tool',
                    toolCallId,
                    toolName: entry.toolName,
                    argumentsJson: entry.argumentsJson,
                    status: 'pending',
                    ...(entry.output !== undefined ? { output: entry.output } : {}),
                    ...(entry.error !== undefined ? { error: entry.error } : {}),
                },
            });
        }
        openTools.clear();
        pending.sort((a, b) => a.openSeq - b.openSeq);
        return pending.map((p) => p.block);
    };

    return { consume, flush };
}

function joinDeltas(deltas: ReadonlyArray<{ sequence: number; delta: string }>): string {
    return [...deltas]
        .sort((a, b) => a.sequence - b.sequence)
        .map((d) => d.delta)
        .join('');
}

function errorMessageFor(event: AgentEvent): string {
    if (event.message !== undefined) {
        return event.message;
    }
    if (event.run?.reason !== undefined) {
        return event.run.reason;
    }
    return event.type;
}

function isGenericModelCallLabel(event: AgentEvent): boolean {
    if (event.abg?.nodeId === undefined) return false;
    return event.message === `model.call.completed: ${event.abg.nodeId}`;
}
