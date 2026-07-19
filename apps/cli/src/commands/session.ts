import {
    type CodingReplayStep,
    createProviderAuthStore,
    createProviderAuthStoreObservabilityRedactor,
    type ObservabilityRedactor,
    type ReplayDiagnostic,
    readLocalSessionReplay,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { CliArgs } from '../args';
import { type CliCommandResult, successfulCliCommand } from '../cli-command-result';
import { formatSessionStatusWithSource } from '../ui/session-status-format';
import { exportSessionArchiveFile, importSessionArchiveFile } from './session-archive';
import {
    type CliSessionCatalogEntry,
    formatSessionCatalogEntry,
    listSessionCatalogEntries,
    readSessionCatalogEntry,
} from './session-catalog';
import { CliSessionCommandError } from './session-command-error';
import { deleteSessionTree } from './session-delete-command';
import { parseCliSessionId } from './session-id';
import { runSessionStopCommand } from './session-stop-command';

export type { CliSessionCommandErrorCode } from './session-command-error';
export { CliSessionCommandError };

export async function runSessionCommand(args: CliArgs): Promise<CliCommandResult> {
    const loadObservabilityRedactor = () => createProviderAuthStoreObservabilityRedactor(createProviderAuthStore());
    switch (args.command) {
        case 'session-list': {
            const observabilityRedactor = await loadObservabilityRedactor();
            return successfulCliCommand(
                (await listSessionCatalogEntries(observabilityRedactor)).map(formatSessionCatalogEntry).join('\n'),
            );
        }
        case 'session-status': {
            const observabilityRedactor = await loadObservabilityRedactor();
            return successfulCliCommand(await statusSession(args.sessionId, observabilityRedactor));
        }
        case 'session-show': {
            const observabilityRedactor = await loadObservabilityRedactor();
            return successfulCliCommand(
                JSON.stringify(await showSession(requireSessionId(args), observabilityRedactor), null, 2),
            );
        }
        case 'session-replay': {
            const observabilityRedactor = await loadObservabilityRedactor();
            if (args.replayInteractive === true) {
                await runReplayInteractiveSession(requireSessionId(args), observabilityRedactor);
                return successfulCliCommand('');
            }
            return successfulCliCommand(
                (await replaySession(requireSessionId(args), observabilityRedactor))
                    .map((record) => JSON.stringify(record))
                    .join('\n'),
            );
        }
        case 'session-export':
            return successfulCliCommand(
                stripTrailingLineFeed(
                    await exportSessionArchiveFile({
                        sessionId: requireSessionId(args),
                        filePath: requireFilePath(args),
                    }),
                ),
            );
        case 'session-import':
            return successfulCliCommand(
                stripTrailingLineFeed(await importSessionArchiveFile({ filePath: requireFilePath(args) })),
            );
        case 'session-delete':
            return successfulCliCommand(
                await deleteSessionTree({
                    sessionId: requireSessionId(args),
                    ...(args.expectedTreeToken !== undefined ? { expectedTreeToken: args.expectedTreeToken } : {}),
                }),
            );
        case 'session-stop':
            return runSessionStopCommand(args);
        default:
            throw new CliSessionCommandError({
                code: 'unsupported_session_command',
                message: `Unsupported session command: ${args.command}`,
            });
    }
}

function stripTrailingLineFeed(value: string): string {
    return value.endsWith('\n') ? value.slice(0, -1) : value;
}

async function statusSession(
    sessionId: string | undefined,
    observabilityRedactor: ObservabilityRedactor,
): Promise<string> {
    if (sessionId === undefined) {
        return (await listSessionCatalogEntries(observabilityRedactor)).map(formatSessionStatusLine).join('\n');
    }
    const parsedSessionId = requireValidSessionId(sessionId);
    const entry = await readSessionCatalogEntry(parsedSessionId, undefined, observabilityRedactor);
    if (entry.status === 'missing') {
        throw new CliSessionCommandError({
            code: 'session_not_found',
            message: `Session not found: ${parsedSessionId}`,
            sessionId: parsedSessionId,
        });
    }
    return formatSessionStatusLine(entry);
}

function formatSessionStatusLine(entry: CliSessionCatalogEntry): string {
    const awaiting = entry.status === 'awaiting' ? entry.awaiting : undefined;
    return [
        `session=${entry.sessionId}`,
        `status=${entry.status}`,
        awaiting === undefined ? undefined : `reason=${awaiting.reason}`,
        awaiting?.source.runId === undefined ? undefined : `runId=${awaiting.source.runId}`,
        awaiting?.source.toolCallId === undefined ? undefined : `toolCallId=${awaiting.source.toolCallId}`,
        awaiting?.source.childSessionId === undefined ? undefined : `childSessionId=${awaiting.source.childSessionId}`,
        entry.updatedAt === undefined ? undefined : `updatedAt=${entry.updatedAt}`,
    ]
        .filter((part) => part !== undefined)
        .join(' ');
}

async function showSession(sessionId: string, observabilityRedactor: ObservabilityRedactor) {
    const summary = await readSessionCatalogEntry(sessionId, undefined, observabilityRedactor);
    const projection = await requireSessionReplay(sessionId, observabilityRedactor);
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

async function replaySession(
    sessionId: string,
    observabilityRedactor: ObservabilityRedactor,
): Promise<readonly ReplayJsonlRecord[]> {
    const replay = await requireSessionReplay(sessionId, observabilityRedactor);
    const stepsByEventId = codingStepsByEventId(replay.projection.codingSteps);
    return [
        ...replay.projection.envelopes.flatMap((envelope) => [
            { kind: 'event' as const, event: envelope.event },
            ...(stepsByEventId.get(envelope.eventId) ?? []).map((step) => ({ kind: 'coding.step' as const, step })),
        ]),
        ...replay.diagnostics.map((diagnostic) => ({ kind: 'diagnostic' as const, diagnostic })),
    ];
}

async function runReplayInteractiveSession(
    sessionId: string,
    observabilityRedactor: ObservabilityRedactor,
): Promise<void> {
    const replay = await requireSessionReplay(sessionId, observabilityRedactor);
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

async function requireSessionReplay(sessionId: string, observabilityRedactor: ObservabilityRedactor) {
    const parsedSessionId = requireValidSessionId(sessionId);
    const replay = await readLocalSessionReplay({ sessionId: parsedSessionId, observabilityRedactor });
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
