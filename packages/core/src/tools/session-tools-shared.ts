/**
 * Shared internals for the four `session_*` read tools (`session_list`, `session_read`,
 * `session_search`, `session_info`).
 *
 * These tools are a READ layer over mission-control's EXISTING durable JSONL sessions
 * (`<dataDir>/sessions/<id>.jsonl`). They do NOT add a new store: every projection comes
 * from `projectJsonlSessionReplayPrefix` (see `session-replay.ts`), which already parses,
 * validates, and derives the replay projection used by the CLI/desktop.
 *
 * Approach (clean-room relative to external session-manager references): understand the
 * shapes needed (list/read/search/info + redaction + bounded search), then reimplement fresh
 * against this codebase's own durable-session projection. No expression-level copying.
 *
 * Guarantees:
 * - Reads only `<dataDir>/sessions/`; session ids are validated against the same charset the
 *   JSONL store accepts (`[A-Za-z0-9._-]+`) before each path is touched.
 * - Defensive secret redaction runs over every message text surfaced to the model, so a key
 *   that slipped into a stored message is masked before it reaches tool output.
 * - `session_search` is bounded: a 60s overall timeout and a 50-session scan cap.
 */

import type { AgentEventEnvelope } from '@mission-control/protocol';
import { resolveMissionControlDataDir } from '../memory/data-dir.js';
import { projectJsonlSessionReplayPrefix } from '../session-replay.js';
import type { ReplayDiagnostic, SessionReplayProjection } from '../session-replay-types.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Maximum overall wall-clock for a single `session_search` invocation. */
export const SESSION_SEARCH_TIMEOUT_MS = 60_000;
/** Maximum number of sessions `session_search` scans when no `session_id` is given. */
export const MAX_SESSIONS_TO_SCAN = 50;
/** Default and maximum number of search results returned. */
export const DEFAULT_SEARCH_LIMIT = 20;
/** Charset the JSONL session store accepts for session ids (see `jsonl-session-files.ts`). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const SESSION_REDACTED = '[REDACTED]';

/** A single conversational turn extracted from a session projection. */
export type SessionMessageEntry = {
    readonly messageId: string;
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly timestamp: string;
    readonly providerTurnId?: string;
};

/** Lightweight summary used by `session_list` and `session_info`. */
export type SessionSummary = {
    readonly sessionId: string;
    readonly status: string;
    readonly eventCount: number;
    readonly messageCount: number;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly cwd?: string;
    readonly sessionName?: string;
    readonly agentsUsed: string[];
    readonly corrupt: boolean;
};

export type SessionReadOutcome =
    | { readonly kind: 'missing' }
    | { readonly kind: 'found'; readonly summary: SessionSummary; readonly messages: readonly SessionMessageEntry[] };

export type SessionProjectionRead = {
    readonly kind: 'missing' | 'found';
    readonly projection?: SessionReplayProjection;
    readonly diagnostics?: readonly ReplayDiagnostic[];
};

export type SessionToolsOptions = {
    /** Override the Mission Control data directory (defaults to `resolveMissionControlDataDir()`). */
    readonly dataDir?: string;
};

/** Resolve the sessions directory, honoring the `dataDir` override or the env-resolved default. */
export function resolveSessionsDir(options?: SessionToolsOptions): string {
    const dataDir = options?.dataDir ?? resolveMissionControlDataDir();
    return join(dataDir, 'sessions');
}

/** Validate a session id against the JSONL store charset. Returns `undefined` when invalid. */
export function normalizeSessionId(sessionId: string): string | undefined {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return undefined;
    }
    return SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
}

/** List durable session ids found under `<dataDir>/sessions/`. Never throws. */
export async function listSessionIds(options?: SessionToolsOptions): Promise<readonly string[]> {
    const dir = resolveSessionsDir(options);
    let entries: readonly string[];
    try {
        entries = await readdir(dir);
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return [];
        }
        return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) {
            continue;
        }
        const id = entry.slice(0, -'.jsonl'.length);
        if (SESSION_ID_PATTERN.test(id)) {
            ids.push(id);
        }
    }
    return ids.sort();
}

/** Read + project a single session log. Returns `missing` when the file is absent. */
export async function readSessionProjection(
    sessionId: string,
    options?: SessionToolsOptions,
): Promise<SessionProjectionRead> {
    const id = normalizeSessionId(sessionId);
    if (id === undefined) {
        return { kind: 'missing' };
    }
    const filePath = join(resolveSessionsDir(options), `${id}.jsonl`);
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return { kind: 'missing' };
        }
        throw error;
    }
    const replay = projectJsonlSessionReplayPrefix({ sessionId: id, contents });
    return { kind: 'found', projection: replay.projection, diagnostics: replay.diagnostics };
}

/** Derive a compact summary from a projection (used by list/info). */
export function summarizeProjection(sessionId: string, projection: SessionReplayProjection): SessionSummary {
    const events = projection.events;
    const first = events.at(0)?.timestamp;
    const last = events.at(-1)?.timestamp;
    return {
        sessionId,
        status: projection.snapshot.status,
        eventCount: events.length,
        messageCount: projection.codingSteps.filter((step) => step.kind === 'provider.message').length,
        ...(first !== undefined ? { createdAt: first } : {}),
        ...(last !== undefined ? { updatedAt: last } : {}),
        ...(projection.sessionTree.cwd !== undefined ? { cwd: projection.sessionTree.cwd } : {}),
        ...(projection.sessionTree.sessionName !== undefined
            ? { sessionName: projection.sessionTree.sessionName }
            : {}),
        agentsUsed: uniqueAgents(projection.envelopes),
        corrupt: false,
    };
}

/** Extract ordered user/assistant conversational turns from a projection. */
export function extractMessages(projection: SessionReplayProjection): readonly SessionMessageEntry[] {
    const messages: SessionMessageEntry[] = [];
    for (const step of projection.codingSteps) {
        if (step.kind === 'provider.message') {
            messages.push({
                messageId: step.messageId,
                role: 'assistant',
                text: step.message,
                timestamp: step.timestamp,
                ...(step.providerTurnId !== undefined ? { providerTurnId: step.providerTurnId } : {}),
            });
        }
    }
    for (const envelope of projection.envelopes) {
        const event = envelope.event;
        if (event.type !== 'run.command.received') {
            continue;
        }
        if (typeof event.message !== 'string' || event.message.length === 0) {
            continue;
        }
        messages.push({
            messageId: envelope.eventId,
            role: 'user',
            text: event.message,
            timestamp: event.timestamp,
        });
    }
    return messages.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

/**
 * Defensive secret redaction. Stored events should already be redacted upstream (provider
 * redaction keeps raw secrets out of JSONL), but this masks common credential shapes in every
 * message text surfaced to the model so a leaked key can never reach tool output.
 */
export function redactSessionText(text: string): string {
    if (text.length === 0) {
        return text;
    }
    let redacted = text;
    for (const pattern of SECRET_PATTERNS) {
        redacted = redacted.replace(pattern, SESSION_REDACTED);
    }
    return redacted;
}

// Patterns intentionally narrow: long, high-entropy tokens in typical API-key shapes. Generic
// prose is never matched because each pattern requires a key-like prefix or a labeled assignment.
const SECRET_PATTERNS: readonly RegExp[] = [
    // OpenAI: sk-... (incl. sk-proj-, sk-ant- variants share the sk- prefix)
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    // Anthropic: sk-ant-...
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    // Google AI: AIza...
    /\bAIza[A-Za-z0-9_-]{30,}\b/g,
    // Generic labeled assignment: api_key/apikey/authorization/bearer/token = "..." or : "..."
    /\b(?:api[_-]?key|secret|authorization|bearer|token)\b\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}['"]?/gi,
];

function uniqueAgents(envelopes: readonly AgentEventEnvelope[]): string[] {
    const seen = new Set<string>();
    const agents: string[] = [];
    for (const envelope of envelopes) {
        const providerTurnId = envelope.event.transcript?.providerTurnId;
        if (providerTurnId !== undefined && !seen.has(providerTurnId)) {
            seen.add(providerTurnId);
            agents.push(providerTurnId);
        }
    }
    return agents;
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}
