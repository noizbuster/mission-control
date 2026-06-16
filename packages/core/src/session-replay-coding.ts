import {
    type AgentEvent,
    type AgentEventEnvelope,
    type ProtocolError,
    ProtocolErrorSchema,
    type ToolResult,
} from '@mission-control/protocol';
import type { CodingReplayStep, ReplayDiagnostic } from './session-replay-types.js';

const RUN_REPLAY_EVENT_TYPES: ReadonlySet<AgentEvent['type']> = new Set([
    'run.command.received',
    'run.started',
    'run.completed',
    'run.interrupted',
    'run.idle',
    'run.failed',
    'run.blocked',
]);

export function projectCodingSteps(envelopes: readonly AgentEventEnvelope[]): readonly CodingReplayStep[] {
    const appliedFiles = appliedFilesByToolCallId(envelopes.map((envelope) => envelope.event));
    const continuationSequences = new Set(continuationMessageSequences(envelopes));
    return envelopes.flatMap((envelope) => stepForEnvelope(envelope, appliedFiles, continuationSequences));
}

export function projectReplayDiagnostics(envelopes: readonly AgentEventEnvelope[]): readonly ReplayDiagnostic[] {
    const toolNames = providerToolNamesByCallId(envelopes);
    const continuationSequences = continuationMessageSequences(envelopes);
    const blockedApprovalToolCallIds = blockedApprovalToolCallIdsSet(envelopes);
    const stoppedAfter = lastStoppedSequence(envelopes);
    if (stoppedAfter === undefined) {
        return [];
    }
    return envelopes.flatMap((envelope) => {
        const result = envelope.event.toolResult;
        if (
            result === undefined ||
            blockedApprovalToolCallIds.has(result.toolCallId) ||
            hasContinuationAfter(continuationSequences, envelope.sequence)
        ) {
            return [];
        }
        return [
            {
                code: 'missing_provider_continuation',
                eventId: envelope.eventId,
                sessionId: envelope.sessionId,
                toolCallId: result.toolCallId,
                toolName: toolNames.get(result.toolCallId) ?? result.toolCallId,
            },
        ];
    });
}

function stepForEnvelope(
    envelope: AgentEventEnvelope,
    appliedFiles: ReadonlyMap<string, readonly string[]>,
    continuationSequences: ReadonlySet<number>,
): readonly CodingReplayStep[] {
    const event = envelope.event;
    const runStep = runStateStep(envelope);
    if (runStep !== undefined) {
        return [runStep];
    }
    const graphStep = graphEmitStep(envelope);
    if (graphStep !== undefined) {
        return [graphStep];
    }
    const chunk = event.providerStreamChunk;
    if (chunk?.kind === 'tool_call_completed') {
        return [
            {
                kind: 'provider.tool_call',
                eventId: envelope.eventId,
                timestamp: event.timestamp,
                ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
                toolCallId: chunk.toolCall.toolCallId,
                toolName: chunk.toolCall.toolName,
            },
        ];
    }
    if (chunk?.kind === 'response_completed') {
        const providerTurnId = event.transcript?.providerTurnId ?? event.taskId;
        return [
            {
                kind: 'provider.message',
                eventId: envelope.eventId,
                timestamp: event.timestamp,
                ...(providerTurnId !== undefined ? { providerTurnId } : {}),
                messageId: event.transcript?.messageId ?? chunk.message.messageId,
                message: chunk.message.content,
                continuation: continuationSequences.has(envelope.sequence),
            },
        ];
    }
    if (chunk?.kind === 'response_failed') {
        return [
            {
                kind: 'provider.failure',
                eventId: envelope.eventId,
                timestamp: event.timestamp,
                ...(event.transcript?.providerTurnId !== undefined
                    ? { providerTurnId: event.transcript.providerTurnId }
                    : {}),
                requestId: chunk.requestId,
                error: chunk.error,
            },
        ];
    }
    if (event.approvalRecord !== undefined) {
        return [
            {
                kind: 'approval',
                eventId: envelope.eventId,
                timestamp: event.timestamp,
                approvalId: event.approvalRecord.approvalId,
                state: event.approvalRecord.state,
                subject: event.approvalRecord.subject,
            },
        ];
    }
    if (event.toolResult !== undefined) {
        return [toolResultStep(envelope, event.toolResult, appliedFiles.get(event.toolResult.toolCallId))];
    }
    return [];
}

function runStateStep(envelope: AgentEventEnvelope): CodingReplayStep | undefined {
    const event = envelope.event;
    const run = event.run;
    if (run === undefined || !RUN_REPLAY_EVENT_TYPES.has(event.type)) {
        return undefined;
    }
    return {
        kind: 'run.state',
        eventId: envelope.eventId,
        timestamp: event.timestamp,
        eventType: event.type,
        ...(run.command !== undefined ? { command: run.command } : {}),
        ...(run.state !== undefined ? { state: run.state } : {}),
        ...(run.runId !== undefined ? { runId: run.runId } : {}),
        ...(run.inputId !== undefined ? { inputId: run.inputId } : {}),
        ...(run.messageId !== undefined ? { messageId: run.messageId } : {}),
        ...(run.parentMessageId !== undefined ? { parentMessageId: run.parentMessageId } : {}),
        ...(run.delivery !== undefined ? { delivery: run.delivery } : {}),
        ...(run.providerTurnId !== undefined ? { providerTurnId: run.providerTurnId } : {}),
        ...(run.toolCallId !== undefined ? { toolCallId: run.toolCallId } : {}),
        ...(run.graphId !== undefined ? { graphId: run.graphId } : {}),
        ...(run.nodeId !== undefined ? { nodeId: run.nodeId } : {}),
        ...(run.reason !== undefined ? { reason: run.reason } : {}),
        ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
        ...(event.message !== undefined ? { message: event.message } : {}),
    };
}

/**
 * Project a graph node's boundary emit (preserved on `event.abg.emit`) into the SAME `CodingReplayStep`
 * kinds the flat provider path produces, so a session's coding-step replay looks identical regardless
 * of which engine drove it. Returns `undefined` for non-graph envelopes (the flat path sets no
 * `abg.emit`) and for emit types with no coding-step analog, so the flat projection is byte-identical.
 *
 * Mappings: `llm.turn.completed` → the assistant message (final text); `llm.tool_call.proposed` →
 * the proposed tool call; `tool.completed`/`tool.failed` → the tool outcome (carrying the settlement's
 * output/error, recorded by the tool bridge's settlement ledger); `llm.error` → a provider failure.
 * The outcome steps therefore match the flat path's detail, not just the call/result lifecycle.
 */
function graphEmitStep(envelope: AgentEventEnvelope): CodingReplayStep | undefined {
    const emit = envelope.event.abg?.emit;
    if (emit === undefined) {
        return undefined;
    }
    switch (emit.type) {
        case 'llm.turn.completed':
            // Emitted per LLMActor turn (one streamText call = one provider turn), mirroring the
            // flat path's per-turn `response_completed`. A tool-only turn carries `text: ''`; that
            // empty message is an intentional turn-boundary marker (the flat path likewise records a
            // `response_completed` for tool-call turns), not noise. `messageId` deliberately aliases
            // the envelope `eventId` — graph emits have no provider-side message id, so the durable
            // event id is the stable handle (no consumer treats graph `messageId` as message-scoped).
            return {
                kind: 'provider.message',
                eventId: envelope.eventId,
                timestamp: envelope.event.timestamp,
                messageId: envelope.eventId,
                message: readStringField(emit.payload, 'text') ?? '',
                continuation: false,
            };
        case 'llm.tool_call.proposed':
            return {
                kind: 'provider.tool_call',
                eventId: envelope.eventId,
                timestamp: envelope.event.timestamp,
                toolCallId: readStringField(emit.payload, 'toolCallId') ?? envelope.eventId,
                toolName: readStringField(emit.payload, 'toolName') ?? 'unknown',
            };
        case 'tool.completed':
            return graphToolResultStep(envelope, emit.payload, 'completed');
        case 'tool.failed':
            return graphToolResultStep(envelope, emit.payload, 'failed');
        case 'llm.error':
            return {
                kind: 'provider.failure',
                eventId: envelope.eventId,
                timestamp: envelope.event.timestamp,
                requestId: envelope.eventId,
                error: {
                    code: 'unknown',
                    message: readStringField(emit.payload, 'error') ?? 'graph llm node failed',
                    retryable: false,
                },
            };
        default:
            return undefined;
    }
}

function graphToolResultStep(
    envelope: AgentEventEnvelope,
    payload: unknown,
    status: ToolResult['status'],
): CodingReplayStep {
    const toolCallId = readStringField(payload, 'toolCallId') ?? envelope.eventId;
    if (status === 'completed') {
        const output = readStringField(payload, 'output');
        return {
            kind: 'tool.result',
            eventId: envelope.eventId,
            timestamp: envelope.event.timestamp,
            toolCallId,
            status,
            ...(output !== undefined ? { output } : {}),
        };
    }
    const error = readProtocolError(payload, 'error');
    return {
        kind: 'tool.result',
        eventId: envelope.eventId,
        timestamp: envelope.event.timestamp,
        toolCallId,
        status,
        ...(error !== undefined ? { error } : {}),
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(payload: unknown, field: string): string | undefined {
    if (!isPlainObject(payload)) {
        return undefined;
    }
    const value = payload[field];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Read + validate a `ProtocolError` from an emit payload. The bridge records the registry's
 * structured error (or a synthesized one), but it traveled through an `unknown` JSON payload,
 * so validate against `ProtocolErrorSchema` before assigning to the typed step field — no cast.
 */
function readProtocolError(payload: unknown, field: string): ProtocolError | undefined {
    if (!isPlainObject(payload)) {
        return undefined;
    }
    const value = payload[field];
    if (!isPlainObject(value)) {
        return undefined;
    }
    const parsed = ProtocolErrorSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function toolResultStep(
    envelope: AgentEventEnvelope,
    result: ToolResult,
    appliedFiles: readonly string[] | undefined,
): CodingReplayStep {
    const base = {
        kind: 'tool.result' as const,
        eventId: envelope.eventId,
        timestamp: envelope.event.timestamp,
        toolCallId: result.toolCallId,
        ...(envelope.event.message !== undefined ? { message: envelope.event.message } : {}),
        ...(appliedFiles !== undefined && appliedFiles.length > 0 ? { appliedFiles } : {}),
    };
    if (result.status === 'completed') {
        return {
            ...base,
            status: 'completed',
            ...(result.output !== undefined ? { output: result.output } : {}),
        };
    }
    return {
        ...base,
        status: 'failed',
        ...(result.error !== undefined ? { error: result.error } : {}),
    };
}

function appliedFilesByToolCallId(events: readonly AgentEvent[]): ReadonlyMap<string, readonly string[]> {
    const applied = new Map<string, readonly string[]>();
    for (const event of events) {
        if (event.type !== 'file.diff.applied' || event.taskId === undefined || event.diffFiles === undefined) {
            continue;
        }
        applied.set(
            event.taskId,
            uniqueStrings([...(applied.get(event.taskId) ?? []), ...event.diffFiles.map((file) => file.filePath)]),
        );
    }
    return applied;
}

function providerToolNamesByCallId(envelopes: readonly AgentEventEnvelope[]): ReadonlyMap<string, string> {
    const toolNames = new Map<string, string>();
    for (const envelope of envelopes) {
        const chunk = envelope.event.providerStreamChunk;
        if (chunk?.kind === 'tool_call_completed') {
            toolNames.set(chunk.toolCall.toolCallId, chunk.toolCall.toolName);
        }
    }
    return toolNames;
}

function blockedApprovalToolCallIdsSet(envelopes: readonly AgentEventEnvelope[]): ReadonlySet<string> {
    const toolCallIds = new Set<string>();
    for (const envelope of envelopes) {
        if (envelope.event.type !== 'run.blocked' || envelope.event.run?.state !== 'blocked_on_approval') {
            continue;
        }
        const toolCallId = envelope.event.run.toolCallId;
        if (toolCallId !== undefined) {
            toolCallIds.add(toolCallId);
        }
    }
    return toolCallIds;
}

function continuationMessageSequences(envelopes: readonly AgentEventEnvelope[]): readonly number[] {
    const sequences: number[] = [];
    let awaitingToolContinuation = false;
    for (const envelope of envelopes) {
        if (resetsContinuationTracking(envelope.event, awaitingToolContinuation)) {
            awaitingToolContinuation = false;
        }
        const providerTurnId = envelope.event.transcript?.providerTurnId;
        const chunk = envelope.event.providerStreamChunk;
        if (chunk?.kind === 'response_completed') {
            if (awaitingToolContinuation || providerTurnId?.includes('_continue_') === true) {
                sequences.push(envelope.sequence);
            }
            awaitingToolContinuation = false;
        }
        if (envelope.event.toolResult !== undefined) {
            awaitingToolContinuation = true;
        }
    }
    return sequences;
}

function resetsContinuationTracking(event: AgentEvent, awaitingToolContinuation: boolean): boolean {
    if (event.type === 'prompt.promoted') {
        return true;
    }
    if (event.type !== 'run.started') {
        return false;
    }
    return !(awaitingToolContinuation && event.run?.command === 'resume');
}

function lastStoppedSequence(envelopes: readonly AgentEventEnvelope[]): number | undefined {
    let sequence: number | undefined;
    for (const envelope of envelopes) {
        if (envelope.event.type === 'session.stopped') {
            sequence = envelope.sequence;
        }
    }
    return sequence;
}

function hasContinuationAfter(continuationSequences: readonly number[], sequence: number): boolean {
    return continuationSequences.some((continuationSequence) => continuationSequence > sequence);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}
