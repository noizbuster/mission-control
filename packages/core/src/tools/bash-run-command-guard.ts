import { commandRunFailure } from './command-run-errors.js';
import { basename } from 'node:path';

const forbiddenControlCharacters = new Set(['&', '|', ';', '<', '>', '(', ')', '{', '}']);
const deniedShellCommands = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);
const deniedWrapperCommands = new Set(['env', 'command', 'builtin', 'exec', 'sudo']);
const deniedRemoteCommands = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'socat']);
const deniedBackgroundCommands = new Set(['nohup', 'disown', 'setsid', 'tmux', 'screen']);
const deniedInteractiveCommands = new Set(['vim', 'vi', 'nano', 'less', 'more', 'top', 'watch', 'tail', 'read']);
const deniedPublishCommands = new Set(['npm', 'pnpm', 'yarn', 'cargo']);
const interpreterEvalFlags = new Map<string, readonly string[]>([
    ['node', ['-e', '--eval']],
    ['python', ['-c', '-m']],
    ['python3', ['-c', '-m']],
    ['ruby', ['-e']],
    ['perl', ['-e']],
    ['php', ['-r']],
]);

export function parseTrustedCommandLine(commandLine: string): readonly string[] {
    if (commandLine.includes('\0')) {
        throw denied('null bytes are denied');
    }
    const argv = tokenizeShellWords(commandLine);
    enforceTrustedCommandPolicy(argv);
    return argv;
}

function tokenizeShellWords(commandLine: string): readonly string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;

    for (let index = 0; index < commandLine.length; index += 1) {
        const char = commandLine[index];
        if (char === undefined) {
            continue;
        }
        if (quote === null) {
            if (char === '\\') {
                const next = commandLine[index + 1];
                if (next === undefined) {
                    throw denied('trailing escape is denied');
                }
                current += next;
                index += 1;
                continue;
            }
            if (char === "'" || char === '"') {
                quote = char;
                continue;
            }
            if (char === '$' || char === '`') {
                throw denied('shell expansions are denied');
            }
            if (char === '\n' || char === '\r') {
                throw denied('multi-line shell input is denied');
            }
            if (forbiddenControlCharacters.has(char)) {
                throw denied('shell control operators are denied');
            }
            if (/\s/u.test(char)) {
                pushToken(tokens, current);
                current = '';
                continue;
            }
            current += char;
            continue;
        }

        if (quote === "'") {
            if (char === "'") {
                quote = null;
                continue;
            }
            current += char;
            continue;
        }

        if (char === '"') {
            quote = null;
            continue;
        }
        if (char === '\\') {
            const next = commandLine[index + 1];
            if (next === undefined) {
                throw denied('trailing escape is denied');
            }
            current += next;
            index += 1;
            continue;
        }
        if (char === '$' || char === '`') {
            throw denied('shell expansions are denied');
        }
        current += char;
    }

    if (quote !== null) {
        throw denied('unterminated quotes are denied');
    }
    pushToken(tokens, current);
    if (tokens.length === 0) {
        throw denied('empty shell input is denied');
    }
    return tokens;
}

function pushToken(tokens: string[], token: string): void {
    if (token.length > 0) {
        tokens.push(token);
    }
}

function enforceTrustedCommandPolicy(argv: readonly string[]): void {
    const commandToken = argv[0];
    if (commandToken === undefined) {
        throw denied('empty shell input is denied');
    }
    if (/\s/u.test(commandToken)) {
        throw denied('unsafe escaped whitespace in command token is denied');
    }
    if (isEnvironmentAssignment(commandToken)) {
        throw denied('environment-prefixed commands are denied');
    }

    const command = basename(commandToken).toLowerCase();
    const args = argv.slice(1);

    if (deniedShellCommands.has(command)) {
        throw denied('nested or interactive shells are denied');
    }
    if (deniedWrapperCommands.has(command)) {
        throw denied('command wrappers are denied');
    }
    if (deniedRemoteCommands.has(command)) {
        throw denied('remote and network commands are denied');
    }
    if (interpreterUsesDeniedEval(command, args)) {
        throw denied('interpreter eval and module execution modes are denied');
    }
    if (deniedBackgroundCommands.has(command)) {
        throw denied('background or daemonized execution is denied');
    }
    if (command === 'tail' && hasArgument(args, '-f')) {
        throw denied('streaming interactive commands are denied');
    }
    if (command === 'read' || deniedInteractiveCommands.has(command)) {
        throw denied('interactive commands are denied');
    }
    if (command === 'rm') {
        throw denied('filesystem removal commands are denied');
    }
    if (deniedPublishCommands.has(command) && hasToken(args, 'publish')) {
        throw denied('package publishing is denied');
    }
    if (
        (command === 'docker' && hasToken(args, 'push')) ||
        (command === 'gh' && hasToken(args, 'release')) ||
        (command === 'kubectl' && hasToken(args, 'apply')) ||
        (command === 'terraform' && hasToken(args, 'apply')) ||
        (command === 'vercel' && hasToken(args, 'deploy')) ||
        (command === 'netlify' && hasToken(args, 'deploy')) ||
        (command === 'wrangler' && hasToken(args, 'deploy'))
    ) {
        throw denied('external deployment side effects are denied');
    }
    if (command === 'git') {
        enforceGitPolicy(args);
    }
}

function enforceGitPolicy(args: readonly string[]): void {
    if (hasToken(args, 'push')) {
        throw denied('git push is denied from trusted bash');
    }
    if (hasToken(args, 'reset') && hasArgument(args, '--hard')) {
        throw denied('destructive git reset is denied');
    }
    if (hasToken(args, 'clean') && hasShortFlag(args, 'f')) {
        throw denied('destructive git clean is denied');
    }
    if (hasToken(args, 'checkout') && args.includes('--')) {
        throw denied('destructive git checkout is denied');
    }
    if (
        hasToken(args, 'restore') &&
        (hasArgument(args, '--source') || hasArgument(args, '--staged') || hasArgument(args, '--worktree'))
    ) {
        throw denied('destructive git restore is denied');
    }
}

function hasArgument(args: readonly string[], target: string): boolean {
    return args.some((arg) => arg.toLowerCase() === target.toLowerCase());
}

function hasToken(args: readonly string[], target: string): boolean {
    return args.some((arg) => !arg.startsWith('-') && arg.toLowerCase() === target.toLowerCase());
}

function hasShortFlag(args: readonly string[], flag: string): boolean {
    return args.some((arg) => arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(flag));
}

function interpreterUsesDeniedEval(command: string, args: readonly string[]): boolean {
    const deniedFlags = interpreterEvalFlags.get(command);
    return deniedFlags !== undefined && args.some((arg) => deniedFlags.includes(arg.toLowerCase()));
}

function isEnvironmentAssignment(token: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token);
}

function denied(message: string) {
    return commandRunFailure('command_not_allowed', message);
}
