import {
    type CodingReplayStep,
    projectJsonlSessionReplayPrefix,
    type ReplayDiagnostic,
    resolveMissionControlDataDir,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { runReplayOverlay } from './replay-overlay.js';
import { exportSessionArchiveFile, importSessionArchiveFile } from './session-archive.js';
import { formatSessionCatalogEntry, listSessionCatalogEntries, readSessionCatalogEntry } from './session-catalog.js';
import { parseCliSessionId } from './session-id.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type CliSessionCommandErrorCode = 'invalid_session_id' | 'session_not_found' | 'unsupported_session_command';

export class CliSessionCommandError extends Error {
    readonly code: CliSessionCommandErrorCode;
    readonly sessionId?: string;

    constructor(input: {
        readonly code: CliSessionCommandErrorCode;
        readonly message: string;
        readonly sessionId?: string;
    }) {
        super(input.message);
        this.name = 'CliSessionCommandError';
        this.code = input.code;
        if (input.sessionId !== undefined) {
            this.sessionId = input.sessionId;
        }
    }
}

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
        default:
            throw new CliSessionCommandError({
                code: 'unsupported_session_command',
                message: `Unsupported session command: ${args.command}`,
            });
    }
}

async function showSession(sessionId: string) {
    const summary = await readSessionCatalogEntry(sessionId);
    const projection = projectJsonlSessionReplayPrefix({
        sessionId,
        contents: await readSessionLog(sessionId),
    });
    return {
        sessionId,
        status: summary.status,
        eventCount: summary.eventCount,
        messageCount: summary.messageCount,
        lockState: summary.lockState,
        createdAt: summary.createdAt,
        indexed: summary.indexed,
        indexState: summary.indexState,
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
    const replay = projectJsonlSessionReplayPrefix({
        sessionId,
        contents: await readSessionLog(sessionId),
    });
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
    const replay = projectJsonlSessionReplayPrefix({
        sessionId,
        contents: await readSessionLog(sessionId),
    });
    if (replay.projection.envelopes.length === 0) {
        process.stderr.write(`No events found for session ${sessionId}\n`);
        return;
    }
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

async function readSessionLog(sessionId: string): Promise<string> {
    const parsedSessionId = requireValidSessionId(sessionId);
    try {
        return await readFile(join(sessionLogsDir(), `${parsedSessionId}.jsonl`), 'utf8');
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            throw new CliSessionCommandError({
                code: 'session_not_found',
                message: `Session log not found: ${parsedSessionId}`,
                sessionId: parsedSessionId,
            });
        }
        throw error;
    }
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

function sessionLogsDir(): string {
    return join(resolveMissionControlDataDir(), 'sessions');
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}
