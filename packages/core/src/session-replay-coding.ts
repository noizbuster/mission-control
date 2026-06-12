import type { AgentEvent, AgentEventEnvelope, ToolResult } from '@mission-control/protocol';
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
    const stoppedAfter = lastStoppedSequence(envelopes);
    if (stoppedAfter === undefined) {
        return [];
    }
    return envelopes.flatMap((envelope) => {
        const result = envelope.event.toolResult;
        if (result === undefined || hasContinuationAfter(continuationSequences, envelope.sequence)) {
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

function continuationMessageSequences(envelopes: readonly AgentEventEnvelope[]): readonly number[] {
    const sequences: number[] = [];
    let awaitingToolContinuation = false;
    for (const envelope of envelopes) {
        if (startsNewProviderInput(envelope.event)) {
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

function startsNewProviderInput(event: AgentEvent): boolean {
    return event.type === 'run.started' || event.type === 'prompt.promoted';
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
