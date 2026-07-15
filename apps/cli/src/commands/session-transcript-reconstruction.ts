import type { CodingReplayStep } from '@mission-control/core';
import { type ObservabilityRedactor, readLocalSessionReplay } from '@mission-control/core';
import type { AgentEventEnvelope } from '@mission-control/protocol';

/**
 * Minimal structural input for {@link reconstructSessionTranscript}. Narrowed from
 * `SessionReplayProjection` so the function depends only on the fields it reads and
 * unit tests can construct a fixture without building the full projection shape.
 */
export type SessionTranscriptInput = {
    readonly envelopes: readonly AgentEventEnvelope[];
    readonly codingSteps: readonly CodingReplayStep[];
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
