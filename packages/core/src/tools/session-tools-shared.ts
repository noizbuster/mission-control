import type { AgentEventEnvelope, SessionAwaitingDetails } from '@mission-control/protocol';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { openLocalSessionProjectionStore, readLocalSessionReplay } from '../memory/local-session-store';
import { REDACTED_CREDENTIAL } from '../providers/redaction-handler';
import type { ReplayDiagnostic, SessionReplayProjection } from '../session-replay-types';

export const SESSION_SEARCH_TIMEOUT_MS = 60_000;
export const MAX_SESSIONS_TO_SCAN = 50;
export const DEFAULT_SEARCH_LIMIT = 20;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const SESSION_REDACTED = '[REDACTED]';

export type SessionMessageEntry = {
    readonly messageId: string;
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly timestamp: string;
    readonly providerTurnId?: string;
};

export type SessionSummary = {
    readonly sessionId: string;
    readonly status: string;
    readonly awaiting?: SessionAwaitingDetails;
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
    readonly dataDir?: string;
};

export function resolveSessionDataDir(options?: SessionToolsOptions): string {
    return options?.dataDir ?? resolveMissionControlDataDir();
}

export function normalizeSessionId(sessionId: string): string | undefined {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return undefined;
    }
    return SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
}

export async function listSessionIds(options?: SessionToolsOptions): Promise<readonly string[]> {
    const store = await openLocalSessionProjectionStore({ dataDir: resolveSessionDataDir(options) });
    try {
        return (await store.listSessions()).map((session) => session.sessionId).sort();
    } finally {
        store.close();
    }
}

export async function readSessionProjection(
    sessionId: string,
    options?: SessionToolsOptions,
): Promise<SessionProjectionRead> {
    const id = normalizeSessionId(sessionId);
    if (id === undefined) {
        return { kind: 'missing' };
    }
    const replay = await readLocalSessionReplay({ dataDir: resolveSessionDataDir(options), sessionId: id });
    if (replay.kind === 'missing') {
        return { kind: 'missing' };
    }
    return { kind: 'found', projection: replay.replay.projection, diagnostics: replay.replay.diagnostics };
}

export function summarizeProjection(sessionId: string, projection: SessionReplayProjection): SessionSummary {
    const events = projection.events;
    const first = events.at(0)?.timestamp;
    const last = events.at(-1)?.timestamp;
    return {
        sessionId,
        status: projection.snapshot.status,
        ...(projection.snapshot.awaiting !== undefined ? { awaiting: projection.snapshot.awaiting } : {}),
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

export function redactSessionText(text: string): string {
    if (text.length === 0) {
        return text;
    }
    let redacted = text.replaceAll(REDACTED_CREDENTIAL, SESSION_REDACTED);
    for (const pattern of SECRET_PATTERNS) {
        redacted = redacted.replace(pattern, SESSION_REDACTED);
    }
    return redacted;
}

const SECRET_PATTERNS: readonly RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    /\bAIza[A-Za-z0-9_-]{30,}\b/g,
    /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
    /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
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
