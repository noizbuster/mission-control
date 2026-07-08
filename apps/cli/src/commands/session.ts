import { type CodingReplayStep, type ReplayDiagnostic, readLocalSessionReplay } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { formatSessionStatusWithSource } from '../ui/session-status-format.js';
import { exportSessionArchiveFile, importSessionArchiveFile } from './session-archive.js';
import { formatSessionCatalogEntry, listSessionCatalogEntries, readSessionCatalogEntry } from './session-catalog.js';
import { CliSessionCommandError } from './session-command-error.js';
import { deleteSessionTree } from './session-delete-command.js';
import { parseCliSessionId } from './session-id.js';

export type { CliSessionCommandErrorCode } from './session-command-error.js';
export { CliSessionCommandError };

export async function runSessionCommand(args: CliArgs): Promise<string> {
    switch (args.command) {
        case 'session-list':
            return `${(await listSessionCatalogEntries()).map(formatSessionCatalogEntry).join('\n')}\n`;
        case 'session-show':
            return `${JSON.stringify(await showSession(requireSessionId(args)), null, 2)}\n`;
        case 'session-replay':
            if (args.replayInteractive === true) {
                await runReplayInteractiveSession(requireSessionId(args));
                return '';
            }
            return `${(await replaySession(requireSessionId(args))).map((record) => JSON.stringify(record)).join('\n')}\n`;
        case 'session-export':
            return exportSessionArchiveFile({
                sessionId: requireSessionId(args),
                filePath: requireFilePath(args),
            });
        case 'session-import':
            return importSessionArchiveFile({ filePath: requireFilePath(args) });
        case 'session-delete':
            return deleteSessionTree({
                sessionId: requireSessionId(args),
            });
        default:
            throw new CliSessionCommandError({
                code: 'unsupported_session_command',
                message: `Unsupported session command: ${args.command}`,
            });
    }
}

async function showSession(sessionId: string) {
    const summary = await readSessionCatalogEntry(sessionId);
    const projection = await requireSessionReplay(sessionId);
    return {
        sessionId,
        status: summary.status,
        statusText: formatSessionStatusWithSource(summary),
        awaiting: summary.awaiting,
        eventCount: summary.eventCount,
        messageCount: summary.messageCount,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        cwd: summary.cwd,
        trustedRoot: summary.trustedRoot,
        name: summary.name,
        activeLeafId: summary.activeLeafId,
        parentSessionId: summary.parentSessionId,
        trustStatus: summary.trustStatus,
        snapshot: projection.projection.snapshot,
        graphSnapshots: projection.projection.graphSnapshots,
        approvals: projection.projection.approvals,
        toolOutcomes: projection.projection.toolOutcomes,
        codingSteps: projection.projection.codingSteps,
        diagnostics: summary.diagnostics,
    };
}

type ReplayJsonlRecord =
    | { readonly kind: 'event'; readonly event: AgentEvent }
    | { readonly kind: 'coding.step'; readonly step: CodingReplayStep }
    | { readonly kind: 'diagnostic'; readonly diagnostic: ReplayDiagnostic };

async function replaySession(sessionId: string): Promise<readonly ReplayJsonlRecord[]> {
    const replay = await requireSessionReplay(sessionId);
    const stepsByEventId = codingStepsByEventId(replay.projection.codingSteps);
    return [
        ...replay.projection.envelopes.flatMap((envelope) => [
            { kind: 'event' as const, event: envelope.event },
            ...(stepsByEventId.get(envelope.eventId) ?? []).map((step) => ({ kind: 'coding.step' as const, step })),
        ]),
        ...replay.diagnostics.map((diagnostic) => ({ kind: 'diagnostic' as const, diagnostic })),
    ];
}

async function runReplayInteractiveSession(sessionId: string): Promise<void> {
    const replay = await requireSessionReplay(sessionId);
    if (replay.projection.envelopes.length === 0) {
        process.stderr.write(`No events found for session ${sessionId}\n`);
        return;
    }
    const { runReplayOverlay } = await import('@mission-control/tui/replay-overlay');
    await runReplayOverlay({
        sessionId,
        envelopes: replay.projection.envelopes,
    });
}

function codingStepsByEventId(steps: readonly CodingReplayStep[]): ReadonlyMap<string, readonly CodingReplayStep[]> {
    const byEventId = new Map<string, CodingReplayStep[]>();
    for (const step of steps) {
        byEventId.set(step.eventId, [...(byEventId.get(step.eventId) ?? []), step]);
    }
    return byEventId;
}

async function requireSessionReplay(sessionId: string) {
    const parsedSessionId = requireValidSessionId(sessionId);
    const replay = await readLocalSessionReplay({ sessionId: parsedSessionId });
    if (replay.kind === 'found') {
        return replay.replay;
    }
    throw new CliSessionCommandError({
        code: 'session_not_found',
        message: `Session not found: ${parsedSessionId}`,
        sessionId: parsedSessionId,
    });
}

function requireSessionId(args: CliArgs): string {
    if (args.sessionId === undefined) {
        throw new CliSessionCommandError({
            code: 'invalid_session_id',
            message: 'Session id is required',
        });
    }
    return requireValidSessionId(args.sessionId);
}

function requireFilePath(args: CliArgs): string {
    if (args.filePath === undefined) {
        throw new CliSessionCommandError({
            code: 'invalid_session_id',
            message: 'Session file path is required',
        });
    }
    return args.filePath;
}

function requireValidSessionId(sessionId: string): string {
    const parsed = parseCliSessionId(sessionId);
    if (parsed === undefined) {
        throw new CliSessionCommandError({
            code: 'invalid_session_id',
            message: `Invalid session id: ${sessionId}`,
            sessionId,
        });
    }
    return parsed;
}
