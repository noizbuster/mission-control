import {
    type CodingReplayStep,
    type LocalSessionEventStore,
    type ObservabilityRedactor,
    projectSessionReplay,
    readLocalSessionReplay,
    redactAgentEventForObservability,
} from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import type { TranscriptPart } from '@mission-control/tui/state';

/**
 * Minimal structural input for {@link reconstructSessionTranscript}. Narrowed from
 * `SessionReplayProjection` so the function depends only on the fields it reads and
 * unit tests can construct a fixture without building the full projection shape.
 */
export type SessionTranscriptInput = {
    readonly envelopes: readonly AgentEventEnvelope[];
    readonly codingSteps: readonly CodingReplayStep[];
};

export type ReconstructedTranscript = {
    readonly parts: readonly TranscriptPart[];
    readonly outputText: string;
};
export type ReconstructedSessionAttach = ReconstructedTranscript & {
    readonly events: readonly AgentEvent[];
};

/**
 * Reconstruct the chat transcript text (the `outputText` the TUI renders) from a
 * session's replay projection. Used when resuming a session (`--session <id>`)
 * so the previous conversation is visible in the output window — mirroring how
 * opencode loads prior messages on resume.
 *
 * Mirrors the live renderer's DEFAULT (collapsed-tool) view:
 *   - `prompt.promoted` events become `You: <message>` lines.
 *   - `provider.message` coding steps (non-empty) become `Assistant: <message>` lines.
 *   - `provider.failure` steps become `Error: <message>` lines.
 *   - FAILED `tool.result` steps become `<toolName> failed: <message>` lines
 *     (matching the `TOOL_FAILURE_PATTERN` in chat-blocks so they classify as tool blocks).
 *   - Successful tool results are omitted, matching the live collapsed view where
 *     `renderInteractiveToolSettlement` early-returns when tool output is not expanded.
 *
 * Reconstruction is best-effort and read-only: the durable session store is never
 * touched. The pure function never throws; {@link loadSessionTranscript} swallows
 * file-read errors so resume proceeds with a blank transcript when the log is
 * missing or corrupt.
 */
export function reconstructSessionTranscript(input: SessionTranscriptInput): string {
    if (input.envelopes.length === 0) {
        return '';
    }

    const stepsByEventId = new Map<string, CodingReplayStep>();
    for (const step of input.codingSteps) {
        stepsByEventId.set(step.eventId, step);
    }

    // Map toolCallId → toolName from provider.tool_call steps so failed tool results
    // can render a readable `<toolName> failed:` line (the tool.result step itself
    // carries only toolCallId on the graph path).
    const toolNamesByCallId = new Map<string, string>();
    for (const step of input.codingSteps) {
        if (step.kind === 'provider.tool_call') {
            toolNamesByCallId.set(step.toolCallId, step.toolName);
        }
    }

    const parts: string[] = [];

    for (const envelope of input.envelopes) {
        const event = envelope.event;

        // User prompt: emit on `prompt.promoted` (the model-visible promotion), NOT on
        // `prompt.admitted` (the pre-promotion queue entry that carries the same text).
        if (event.type === 'prompt.promoted' && event.message !== undefined && event.message.length > 0) {
            parts.push(`You: ${event.message}\n`);
            continue;
        }

        // Session finalize marker (terminal status line). Rendered after every other line
        // because the event is appended to the durable stream after `session.stopped`.
        if (event.type === 'session.finalize' && event.sessionFinalize !== undefined) {
            const meta = event.sessionFinalize;
            const line =
                meta.reason !== undefined && meta.reason.length > 0
                    ? `Session ${meta.status}: ${meta.reason}`
                    : `Session ${meta.status}`;
            parts.push(`${line}\n`);
            continue;
        }

        const step = stepsByEventId.get(envelope.eventId);
        if (step === undefined) {
            continue;
        }

        switch (step.kind) {
            case 'provider.message': {
                // Skip tool-only turn markers (empty message). Each non-empty assistant
                // turn gets its own `Assistant:` line, matching the live renderer which
                // emits `Assistant: <content>` for every non-tool-call response_completed.
                if (step.message.length > 0) {
                    parts.push(`Assistant: ${step.message}\n`);
                }
                break;
            }
            case 'provider.failure': {
                parts.push(`Error: ${step.error.message}\n`);
                break;
            }
            case 'tool.result': {
                // Only surface FAILED tools — successful tool output is hidden in the
                // default collapsed view (renderInteractiveToolSettlement early-returns).
                if (step.status === 'failed') {
                    const toolName = toolNamesByCallId.get(step.toolCallId) ?? step.toolCallId;
                    const reason = step.error?.message ?? 'unknown error';
                    parts.push(`${toolName} failed: ${reason}\n`);
                }
                break;
            }
            default:
                // run.state, provider.tool_call, approval: not transcript lines.
                break;
        }
    }

    return parts.join('');
}

/**
 * Reconstruct typed {@link TranscriptPart} rows from a session's replay projection.
 * Produces the same row types the live renderer emits (user, assistant, inline-tool,
 * error) so a resumed session's transcript looks identical to how it looked during
 * the live run. Used when resuming via `--session <id>` or `/session <id>`.
 */
export function reconstructSessionTranscriptParts(input: SessionTranscriptInput): ReconstructedTranscript {
    if (input.envelopes.length === 0) {
        return { parts: [], outputText: '' };
    }

    const stepsByEventId = new Map<string, CodingReplayStep>();
    for (const step of input.codingSteps) {
        stepsByEventId.set(step.eventId, step);
    }

    const toolNamesByCallId = new Map<string, string>();
    for (const step of input.codingSteps) {
        if (step.kind === 'provider.tool_call') {
            toolNamesByCallId.set(step.toolCallId, step.toolName);
        }
    }

    const parts: TranscriptPart[] = [];
    let userPartOccurrence = 0;
    let currentAssistantMessageId: string | undefined;

    for (const envelope of input.envelopes) {
        const event = envelope.event;

        if (event.type === 'prompt.promoted' && event.message !== undefined && event.message.length > 0) {
            userPartOccurrence += 1;
            parts.push({
                id: `resume:user:${userPartOccurrence}`,
                type: 'user',
                text: event.message,
            });
            continue;
        }

        if (event.type === 'session.finalize' && event.sessionFinalize !== undefined) {
            continue;
        }

        const step = stepsByEventId.get(envelope.eventId);
        if (step === undefined) {
            continue;
        }

        switch (step.kind) {
            case 'provider.message': {
                if (step.message.length === 0) {
                    break;
                }
                currentAssistantMessageId = step.messageId;
                parts.push({
                    id: `resume:assistant:${envelope.eventId}`,
                    type: 'assistant',
                    text: step.message,
                    status: 'completed',
                    messageId: step.messageId,
                });
                break;
            }
            case 'provider.failure': {
                parts.push({
                    id: `resume:error:${envelope.eventId}`,
                    type: 'error',
                    text: step.error.message,
                    error: step.error.message,
                    status: 'failed',
                });
                break;
            }
            case 'tool.result': {
                const toolName = toolNamesByCallId.get(step.toolCallId) ?? step.toolCallId;
                const isFailed = step.status === 'failed';
                const output = step.output;
                const errorMessage = isFailed ? (step.error?.message ?? 'unknown error') : undefined;
                parts.push({
                    id: `resume:tool:${envelope.eventId}`,
                    type: 'inline-tool',
                    toolCallId: step.toolCallId,
                    toolName,
                    text: output ?? errorMessage ?? toolName,
                    status: isFailed ? 'failed' : 'completed',
                    ...(output !== undefined ? { output } : {}),
                    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
                    ...(currentAssistantMessageId !== undefined ? { messageId: currentAssistantMessageId } : {}),
                });
                break;
            }
            default:
                break;
        }
    }

    return {
        parts,
        outputText: reconstructSessionTranscript(input),
    };
}

/**
 * Reconstruct a transcript from the already-open session store. Resume must read
 * from the same store that the next turn will use; reopening the default data
 * directory can select a different database and make a valid attached session
 * appear empty.
 */
export function reconstructSessionTranscriptPartsFromEvents(
    sessionId: string,
    events: readonly AgentEvent[],
    observabilityRedactor?: ObservabilityRedactor,
): ReconstructedTranscript {
    const envelopes: AgentEventEnvelope[] = [];
    for (const [sequence, event] of events.entries()) {
        if (event.sessionId !== sessionId) {
            continue;
        }
        const visibleEvent =
            observabilityRedactor === undefined
                ? event
                : redactAgentEventForObservability(event, observabilityRedactor);
        envelopes.push({
            eventId: `resume:${sequence}`,
            sequence,
            createdAt: visibleEvent.timestamp,
            sessionId,
            durability: 'durable',
            event: visibleEvent,
        });
    }
    return reconstructSessionTranscriptParts(projectSessionReplay({ sessionId, envelopes }));
}

/**
 * Load both transcript rows and the raw event history from the already-open store.
 * Attach projection and transcript reconstruction must use one snapshot so a
 * concurrent append cannot make the restored UI internally inconsistent.
 */
export async function loadSessionTranscriptPartsAndEventsFromStore(
    store: LocalSessionEventStore,
    sessionId: string,
    observabilityRedactor?: ObservabilityRedactor,
): Promise<ReconstructedSessionAttach> {
    const empty: ReconstructedSessionAttach = { events: [], parts: [], outputText: '' };
    try {
        const events = await store.getEvents(sessionId);
        return {
            events,
            ...reconstructSessionTranscriptPartsFromEvents(sessionId, events, observabilityRedactor),
        };
    } catch (error: unknown) {
        if (error instanceof Error) {
            return empty;
        }
        throw error;
    }
}

export async function loadSessionTranscriptPartsFromStore(
    store: LocalSessionEventStore,
    sessionId: string,
    observabilityRedactor?: ObservabilityRedactor,
): Promise<ReconstructedTranscript> {
    const attached = await loadSessionTranscriptPartsAndEventsFromStore(store, sessionId, observabilityRedactor);
    return { parts: attached.parts, outputText: attached.outputText };
}

/**
 * Read a session's durable replay from the mission-control data dir and reconstruct its
 * transcript text. Returns an empty string when the log is missing, empty, or
 * corrupt so callers can resume unconditionally without a try/catch.
 */
export async function loadSessionTranscript(
    sessionId: string,
    observabilityRedactor?: ObservabilityRedactor,
): Promise<string> {
    try {
        const replay = await readLocalSessionReplay({
            sessionId,
            ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
        });
        return replay.kind === 'found' ? reconstructSessionTranscript(replay.replay.projection) : '';
    } catch (error: unknown) {
        if (error instanceof Error) {
            return '';
        }
        throw error;
    }
}

export async function loadSessionTranscriptParts(
    sessionId: string,
    observabilityRedactor?: ObservabilityRedactor,
): Promise<ReconstructedTranscript> {
    const empty: ReconstructedTranscript = { parts: [], outputText: '' };
    try {
        const replay = await readLocalSessionReplay({
            sessionId,
            ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
        });
        return replay.kind === 'found' ? reconstructSessionTranscriptParts(replay.replay.projection) : empty;
    } catch (error: unknown) {
        if (error instanceof Error) {
            return empty;
        }
        throw error;
    }
}
