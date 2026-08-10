/**
 * `/auth` slash command parser.
 *
 * The chat dispatcher ({@linkcode ./chat-commands.js}) calls
 * {@linkcode parseAuthCommand} when it sees a line beginning with `/auth`. The
 * parser is pure and side-effect-free; the action runner consumes the
 * {@linkcode AuthCommand} discriminated union and delegates to
 * {@linkcode runAuthCommand}.
 *
 * Subcommands mirror the CLI surface: `login`, `list`/`ls`, and `logout`. Flag
 * parsing reuses {@linkcode parseAuthArgs} so slash and `mc auth ...` stay in
 * lockstep.
 */
import type { CliArgs } from '../args';
import { parseAuthArgs } from '../auth-args';
import { splitCommandParts } from './chat-command-parts';

export type AuthCommand =
    | { readonly kind: 'login'; readonly args: CliArgs }
    | { readonly kind: 'list'; readonly args: CliArgs }
    | { readonly kind: 'logout'; readonly args: CliArgs }
    | { readonly kind: 'invalid'; readonly message: string };

const AUTH_SLASH_HEAD = 'auth';
const AUTH_USAGE = '/auth requires a subcommand: login, list, logout';

/**
 * Parse the tail that follows `/auth ` into an {@linkcode AuthCommand}.
 *
 * Empty input (bare `/auth`) is invalid and returns a usage message. Known
 * subcommands are forwarded to {@linkcode parseAuthArgs}; parse failures become
 * `invalid` actions with the underlying error message.
 */
export function parseAuthCommand(input: string): AuthCommand {
    const parts = splitCommandParts(input);
    if (parts.head.length === 0) {
        return { kind: 'invalid', message: AUTH_USAGE };
    }
    // `auth list`/`ls` take no flags; reject trailing tokens here because
    // parseAuthArgs only inspects argv[0] for those subcommands.
    if ((parts.head === 'list' || parts.head === 'ls') && parts.tail.length > 0) {
        return { kind: 'invalid', message: '/auth list does not accept arguments' };
    }
    const argv = tokenizeAuthTail(input);
    try {
        return authCommandFromCliArgs(parseAuthArgs(argv));
    } catch (error: unknown) {
        return { kind: 'invalid', message: formatAuthParseError(error, parts.head) };
    }
}

/**
 * Try to parse a full chat line as an `/auth` slash command.
 *
 * Returns `undefined` when the line is not an `/auth` command. Otherwise
 * delegates to {@linkcode parseAuthCommand} with the tail.
 */
export function parseAuthSlashLine(line: string): AuthCommand | undefined {
    const trimmed = line.trim();
    if (trimmed === `/${AUTH_SLASH_HEAD}`) {
        return parseAuthCommand('');
    }
    const prefix = `/${AUTH_SLASH_HEAD} `;
    if (!trimmed.startsWith(prefix)) {
        return undefined;
    }
    return parseAuthCommand(trimmed.slice(prefix.length));
}

function authCommandFromCliArgs(args: CliArgs): AuthCommand {
    switch (args.command) {
        case 'auth-login':
            return { kind: 'login', args };
        case 'auth-list':
            return { kind: 'list', args };
        case 'auth-logout':
            return { kind: 'logout', args };
        default:
            return { kind: 'invalid', message: AUTH_USAGE };
    }
}

function tokenizeAuthTail(input: string): string[] {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return [];
    }
    return trimmed.split(/\s+/);
}

function formatAuthParseError(error: unknown, subcommand: string): string {
    const message = error instanceof Error ? error.message : String(error);
    if (
        message === 'Unsupported auth command' ||
        message === 'Unsupported auth command: missing' ||
        subcommand.length === 0
    ) {
        return AUTH_USAGE;
    }
    return message;
}
