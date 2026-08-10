import {
    type CodingReplayStep,
    type LocalLibsqlDb,
    type LocalSessionEventStore,
    type ObservabilityRedactor,
    openCanonicalRuntimeDb,
    projectSessionReplay,
    readLocalSessionReplay,
    redactAgentEventForObservability,
    resolveMissionControlDataDir,
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

/** Display cap for salvaged child yields. Full text remains in `async_jobs`; resume only needs a readable preview. */
const MAX_SALVAGED_CHILD_OUTPUT_CHARS = 8 * 1024;

/** Child job rows durable in `async_jobs` even when the parent event stream never settled a task tool. */
export type ResumableChildJob = {
    readonly jobId: string;
    readonly childSessionId: string;
    readonly status: 'completed' | 'failed' | 'cancelled' | 'queued' | 'running';
    readonly output?: string;
    readonly title?: string;
    readonly agentId?: string;
    readonly completedAt?: string;
};

const CHILD_JOB_ROW_SCHEMA = {
    parse(row: Readonly<Record<string, unknown>>): ResumableChildJob | undefined {
        const jobId = typeof row['job_id'] === 'string' ? row['job_id'] : undefined;
        const childSessionId =
            typeof row['child_session_id'] === 'string' ? row['child_session_id'] : undefined;
        const status = row['status'];
        if (
            jobId === undefined ||
            childSessionId === undefined ||
            (status !== 'completed' &&
                status !== 'failed' &&
                status !== 'cancelled' &&
                status !== 'queued' &&
                status !== 'running')
        ) {
            return undefined;
        }
        const resultJson = typeof row['result_json'] === 'string' ? row['result_json'] : undefined;
        let output: string | undefined;
        if (resultJson !== undefined) {
            try {
                const parsed: unknown = JSON.parse(resultJson);
                if (
                    typeof parsed === 'object' &&
                    parsed !== null &&
                    'output' in parsed &&
                    typeof parsed.output === 'string' &&
                    parsed.output.length > 0
                ) {
                    output = parsed.output;
                }
            } catch {
                // Malformed job result JSON is skipped; resume still shows the job title.
            }
        }
        const title = typeof row['title'] === 'string' && row['title'].length > 0 ? row['title'] : undefined;
        const agentId =
            typeof row['agent_id'] === 'string' && row['agent_id'].length > 0 ? row['agent_id'] : undefined;
        const completedAt =
            typeof row['completed_at'] === 'string'
                ? row['completed_at']
                : typeof row['failed_at'] === 'string'
                  ? row['failed_at']
                  : typeof row['cancelled_at'] === 'string'
                    ? row['cancelled_at']
                    : undefined;
        return {
            jobId,
            childSessionId,
            status,
            ...(output !== undefined ? { output } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(agentId !== undefined ? { agentId } : {}),
            ...(completedAt !== undefined ? { completedAt } : {}),
        };
    },
};

/**
 * Project durable child `async_jobs` rows into transcript parts. Parent event streams can lose
 * task settlements when the process dies mid-delegate (e.g. native TextBuffer exhaustion), while
 * child yields are still written to `async_jobs`. Resume must surface those results.
 */
export function projectChildJobsOntoTranscript(
    base: ReconstructedTranscript,
    jobs: readonly ResumableChildJob[],
): ReconstructedTranscript {
    if (jobs.length === 0) {
        return base;
    }
    const existingChildIds = new Set(
        base.parts.flatMap((part) =>
            part.type === 'subagent' && part.sessionId !== undefined ? [part.sessionId] : [],
        ),
    );
    const salvageParts: TranscriptPart[] = [];
    const salvageLines: string[] = [];
    for (const job of jobs) {
        if (existingChildIds.has(job.childSessionId)) {
            continue;
        }
        if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
            continue;
        }
        const label = job.title ?? job.agentId ?? 'Subagent';
        const rawBody = job.output ?? (job.status === 'failed' ? 'child job failed' : '');
        const body = truncateSalvagedChildOutput(rawBody);
        if (body.length === 0 && job.status === 'completed') {
            // Empty completed yield still deserves a marker so the user sees the child ran.
            salvageParts.push({
                id: `resume:job:${job.jobId}`,
                type: 'subagent',
                text: label,
                title: label,
                status: 'completed',
                sessionId: job.childSessionId,
                toolCallId: job.jobId,
                ...(job.agentId !== undefined ? { agentName: job.agentId } : {}),
            });
            salvageLines.push(`Subagent ${label}: (no output)\n`);
            continue;
        }
        const status = job.status === 'completed' ? 'completed' : 'failed';
        salvageParts.push({
            id: `resume:job:${job.jobId}`,
            type: 'subagent',
            text: body.length > 0 ? body : label,
            title: label,
            status,
            sessionId: job.childSessionId,
            toolCallId: job.jobId,
            ...(job.agentId !== undefined ? { agentName: job.agentId } : {}),
            ...(status === 'failed' && body.length > 0 ? { error: body } : {}),
        });
        salvageLines.push(
            status === 'failed' ? `Subagent ${label} failed: ${body}\n` : `Subagent ${label}: ${body}\n`,
        );
    }
    if (salvageParts.length === 0) {
        return base;
    }
    // Insert salvaged child results before any trailing session.finalize line so the user sees
    // work product above the abort/complete marker.
    return {
        parts: [...base.parts, ...salvageParts],
        outputText: appendBeforeTrailingFinalize(base.outputText, salvageLines.join('')),
    };
}

function truncateSalvagedChildOutput(text: string): string {
    if (text.length <= MAX_SALVAGED_CHILD_OUTPUT_CHARS) {
        return text;
    }
    return `${text.slice(0, MAX_SALVAGED_CHILD_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_SALVAGED_CHILD_OUTPUT_CHARS} chars; full yield in session store]`;
}

function appendBeforeTrailingFinalize(outputText: string, addition: string): string {
    if (addition.length === 0) {
        return outputText;
    }
    if (outputText.length === 0) {
        return addition;
    }
    const finalizePattern = /(?:Session (?:complete|aborted|failed)(?::[^\n]*)?\n)+$/u;
    const match = finalizePattern.exec(outputText);
    if (match === null || match.index === undefined) {
        return `${outputText}${addition}`;
    }
    return `${outputText.slice(0, match.index)}${addition}${outputText.slice(match.index)}`;
}

export async function loadResumableChildJobsForSession(
    sessionId: string,
    dataDir: string = resolveMissionControlDataDir(),
): Promise<readonly ResumableChildJob[]> {
    let runtime: LocalLibsqlDb | undefined;
    try {
        const opened = await openCanonicalRuntimeDb({ dataDir, sessionControlMaintenance: false });
        runtime = opened.runtime;
        const result = await runtime.client.execute({
            sql:
                'SELECT j.job_id AS job_id, j.child_session_id AS child_session_id, j.agent_id AS agent_id, ' +
                'j.status AS status, j.result_json AS result_json, j.completed_at AS completed_at, ' +
                'j.failed_at AS failed_at, j.cancelled_at AS cancelled_at, s.title AS title ' +
                'FROM async_jobs j ' +
                'LEFT JOIN sessions s ON s.session_id = j.child_session_id ' +
                'WHERE j.parent_session_id = ? ' +
                'ORDER BY COALESCE(j.completed_at, j.failed_at, j.cancelled_at, j.queued_at) ASC, j.job_id ASC',
            args: [sessionId],
        });
        const jobs: ResumableChildJob[] = [];
        for (const row of result.rows) {
            if (typeof row !== 'object' || row === null) {
                continue;
            }
            const parsed = CHILD_JOB_ROW_SCHEMA.parse(row as Readonly<Record<string, unknown>>);
            if (parsed !== undefined) {
                jobs.push(parsed);
            }
        }
        return jobs;
    } catch {
        // Best-effort: missing DB / schema still allows event-only resume.
        return [];
    } finally {
        runtime?.close();
    }
}

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
    options: { readonly dataDir?: string } = {},
): Promise<ReconstructedSessionAttach> {
    const empty: ReconstructedSessionAttach = { events: [], parts: [], outputText: '' };
    try {
        const events = await store.getEvents(sessionId);
        const base = reconstructSessionTranscriptPartsFromEvents(sessionId, events, observabilityRedactor);
        const jobs = await loadResumableChildJobsForSession(
            sessionId,
            options.dataDir ?? resolveMissionControlDataDir(),
        );
        const merged = projectChildJobsOntoTranscript(base, jobs);
        return {
            events,
            parts: merged.parts,
            outputText: merged.outputText,
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
    options: { readonly dataDir?: string } = {},
): Promise<ReconstructedTranscript> {
    const empty: ReconstructedTranscript = { parts: [], outputText: '' };
    try {
        const replay = await readLocalSessionReplay({
            sessionId,
            ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
            ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
        });
        if (replay.kind !== 'found') {
            return empty;
        }
        const base = reconstructSessionTranscriptParts(replay.replay.projection);
        const jobs = await loadResumableChildJobsForSession(
            sessionId,
            options.dataDir ?? resolveMissionControlDataDir(),
        );
        return projectChildJobsOntoTranscript(base, jobs);
    } catch (error: unknown) {
        if (error instanceof Error) {
            return empty;
        }
        throw error;
    }
}
