import type { CliArgs } from './args.js';
import { parseCliSessionId } from './commands/session-id.js';

export const SESSION_STOP_USAGE = 'Usage: mc session stop <session-id> [--only | --child-only] [--timeout <duration>]';
export const SESSION_DELETE_USAGE = 'Usage: mc session delete <session-id> [--expected-tree-token <sha256>]';

const STOP_TIMEOUT_PATTERN = /^(0|[1-9]\d*)(ms|s|m)$/;
const EXPECTED_TREE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_SESSION_STOP_TIMEOUT_MS = 15_000;
const MIN_SESSION_STOP_TIMEOUT_MS = 100;
const MAX_SESSION_STOP_TIMEOUT_MS = 300_000;

export class SessionCliUsageError extends Error {
    constructor(usage: string) {
        super(usage);
        this.name = 'SessionCliUsageError';
    }
}

export function parseSessionArgs(argv: readonly string[]): CliArgs {
    const command = argv[0];
    switch (command) {
        case 'list':
        case 'ls':
            if (argv[1] !== undefined) {
                throw new Error(`Unsupported session list argument: ${argv[1]}`);
            }
            return createSessionArgs('session-list');
        case 'show': {
            const sessionId = argv[1];
            if (sessionId === undefined) {
                throw new Error('session show requires a session id');
            }
            if (argv[2] !== undefined) {
                throw new Error(`Unsupported session show argument: ${argv[2]}`);
            }
            return { ...createSessionArgs('session-show'), sessionId };
        }
        case 'replay': {
            const sessionId = argv[1];
            if (sessionId === undefined) {
                throw new Error('session replay requires a session id');
            }
            if (argv[2] === '--interactive' || argv[2] === '-i') {
                if (argv[3] !== undefined) {
                    throw new Error(`Unsupported session replay argument: ${argv[3]}`);
                }
                return { ...createSessionArgs('session-replay'), mode: 'tui', sessionId, replayInteractive: true };
            }
            if (argv[2] !== '--jsonl') {
                throw new Error('session replay requires --jsonl for event output (or --interactive for TUI)');
            }
            if (argv[3] !== undefined) {
                throw new Error(`Unsupported session replay argument: ${argv[3]}`);
            }
            return { ...createSessionArgs('session-replay'), mode: 'jsonl', sessionId };
        }
        case 'export': {
            const sessionId = argv[1];
            const filePath = argv[2];
            if (sessionId === undefined || filePath === undefined) {
                throw new Error('session export requires a session id and archive path');
            }
            if (argv[3] !== undefined) {
                throw new Error(`Unsupported session export argument: ${argv[3]}`);
            }
            return { ...createSessionArgs('session-export'), sessionId, filePath };
        }
        case 'import': {
            const filePath = argv[1];
            if (filePath === undefined) {
                throw new Error('session import requires an archive path');
            }
            if (argv[2] !== undefined) {
                throw new Error(`Unsupported session import argument: ${argv[2]}`);
            }
            return { ...createSessionArgs('session-import'), filePath };
        }
        case 'delete': {
            const sessionId = argv[1];
            if (sessionId === undefined) {
                throw new Error('session delete requires a session id');
            }
            if (argv[2] !== undefined && argv[2] !== '--expected-tree-token') {
                throw new Error(`Unsupported session delete argument: ${argv[2]}`);
            }
            const expectedTreeToken = argv[3];
            if (
                argv[2] === '--expected-tree-token' &&
                (expectedTreeToken === undefined ||
                    !EXPECTED_TREE_TOKEN_PATTERN.test(expectedTreeToken) ||
                    argv[4] !== undefined)
            ) {
                throw new SessionCliUsageError(SESSION_DELETE_USAGE);
            }
            return {
                ...createSessionArgs('session-delete'),
                sessionId,
                ...(expectedTreeToken !== undefined ? { expectedTreeToken } : {}),
            };
        }
        case 'stop':
            return parseSessionStopArgs(argv);
        default:
            throw new Error(`Unsupported session command: ${command ?? ''}`);
    }
}

function parseSessionStopArgs(argv: readonly string[]): CliArgs {
    const sessionId = argv[1];
    if (sessionId === undefined || parseCliSessionId(sessionId) === undefined) {
        throw new SessionCliUsageError(SESSION_STOP_USAGE);
    }
    let scope: 'tree' | 'only' | 'children' = 'tree';
    let scopeSelected = false;
    let timeoutMs = DEFAULT_SESSION_STOP_TIMEOUT_MS;
    let timeoutSelected = false;
    for (let index = 2; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--only' || argument === '--child-only') {
            if (scopeSelected) throw new SessionCliUsageError(SESSION_STOP_USAGE);
            scope = argument === '--only' ? 'only' : 'children';
            scopeSelected = true;
            continue;
        }
        if (argument === '--timeout') {
            if (timeoutSelected) throw new SessionCliUsageError(SESSION_STOP_USAGE);
            const duration = argv[index + 1];
            timeoutMs = parseSessionStopTimeout(duration);
            timeoutSelected = true;
            index += 1;
            continue;
        }
        throw new SessionCliUsageError(SESSION_STOP_USAGE);
    }
    return {
        ...createSessionArgs('session-stop'),
        sessionId,
        sessionStopScope: scope,
        sessionStopTimeoutMs: timeoutMs,
    };
}

function parseSessionStopTimeout(duration: string | undefined): number {
    const match = duration?.match(STOP_TIMEOUT_PATTERN);
    const magnitudeText = match?.[1];
    const unit = match?.[2];
    if (magnitudeText === undefined || unit === undefined) throw new SessionCliUsageError(SESSION_STOP_USAGE);
    const magnitude = Number(magnitudeText);
    const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1_000 : 60_000;
    const timeoutMs = magnitude * multiplier;
    if (
        !Number.isSafeInteger(magnitude) ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < MIN_SESSION_STOP_TIMEOUT_MS ||
        timeoutMs > MAX_SESSION_STOP_TIMEOUT_MS
    ) {
        throw new SessionCliUsageError(SESSION_STOP_USAGE);
    }
    return timeoutMs;
}

function createSessionArgs(command: CliArgs['command']): CliArgs {
    return {
        mode: 'tui',
        useNative: undefined,
        command,
        showHelp: false,
        showVersion: false,
        thinking: false,
    };
}
