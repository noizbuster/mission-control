import { commandRunFailure } from './command-run-errors';
import { basename } from 'node:path';

const forbiddenControlCharacters = new Set(['&', '|', ';', '<', '>', '(', ')', '{', '}']);
const deniedShellCommands = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);
const deniedWrapperCommands = new Set(['env', 'command', 'builtin', 'exec', 'sudo']);
const deniedRemoteCommands = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'socat']);
const deniedBackgroundCommands = new Set(['nohup', 'disown', 'setsid', 'tmux', 'screen']);
const deniedInteractiveCommands = new Set(['vim', 'vi', 'nano', 'less', 'more', 'top', 'watch', 'read']);
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

/**
 * Parse a command line that may contain `|` pipe operators, returning one argv per segment.
 * Each segment is independently tokenized and policy-checked; the `|` character is no longer
 * a forbidden control operator at this entry point (it is still forbidden inside a segment).
 *
 * Security: pipe segments NEVER invoke a shell. Each segment is spawned directly and chained
 * via Node.js `child_process` stdio piping. The same per-command policy still applies to every
 * segment (allowlist, denied commands, no shell expansions, etc.), so a pipe like
 * `cat file | grep pattern` runs as two direct spawns, not as `bash -c "cat file | grep pattern"`.
 *
 * Empty segments (e.g. `cat |`, `| grep`, `cat || grep`) are rejected. A single-segment input
 * behaves identically to `parseTrustedCommandLine`.
 */
export function parseTrustedCommandPipeline(commandLine: string): readonly (readonly string[])[] {
    if (commandLine.includes('\0')) {
        throw denied('null bytes are denied');
    }
    const segments = splitOnPipe(commandLine);
    if (segments.length === 0) {
        throw denied('empty shell input is denied');
    }
    return segments.map((segment) => {
        const argv = tokenizeShellWords(segment);
        enforceTrustedCommandPolicy(argv);
        return argv;
    });
}

/**
 * Split on `|` characters that are NOT inside a quote and NOT escaped. The tokenizer still
 * rejects `$`, backticks, newlines, and the other control characters — `|` is the only
 * operator this split honors, so a malicious `||` or `|&` produces empty segments that the
 * caller rejects. Quote-aware: `"a|b"` is one segment containing the literal `a|b`.
 */
function splitOnPipe(commandLine: string): readonly string[] {
    const segments: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < commandLine.length; index += 1) {
        const char = commandLine[index];
        if (char === undefined) {
            continue;
        }
        if (quote !== null) {
            current += char;
            if (char === quote) {
                quote = null;
            }
            if (char === '\\' && quote === '"') {
                const next = commandLine[index + 1];
                if (next !== undefined) {
                    current += next;
                    index += 1;
                }
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
        }
        if (char === '|') {
            segments.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    segments.push(current);
    if (segments.length > 1) {
        for (const segment of segments) {
            if (segment.trim().length === 0) {
                throw denied('empty pipe segment is denied');
            }
        }
    }
    return segments;
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
                throw denied(
                    'shell control operators are denied (supported chain operators: `|`, `&&`, `||`, `;` at the top level only — use the `cwd` tool option instead of `cd`, avoid output redirection (`>`) and env-var expansion (`$VAR`))',
                );
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

/**
 * Top-level chain operator connecting two pipelines. `&&` runs the right side only when the
 * left side exits 0; `||` runs the right side only when the left side exits non-zero; `;` runs
 * the right side unconditionally. Each operator is enforced by direct-spawn exit-code
 * branching — no shell is ever invoked.
 */
export type ChainOperator = '&&' | '||' | ';';

export type CommandChain = {
    /**
     * One entry per pipeline split on `&&`/`||`/`;`. Each pipeline is itself a list of argv
     * segments (one per `|`-separated command). `pipelines[i]` runs first, then
     * `operators[i]` decides whether `pipelines[i + 1]` runs.
     */
    readonly pipelines: readonly (readonly (readonly string[])[])[];
    /** `operators.length === pipelines.length - 1`; empty for a single-pipeline chain. */
    readonly operators: readonly ChainOperator[];
};

/**
 * Split a command line on top-level `&&`, `||`, and `;`. Quote-aware (operators inside `'…'`
 * or `"…"` are literal). `\` escapes inside `"…"` are honored. A lone `&` (background) is NOT
 * consumed here — it stays in the segment text and `tokenizeShellWords`'s forbidden-char check
 * rejects it later. A lone `|` is also NOT consumed here — it stays a pipe separator at the
 * pipeline level (`splitOnPipe` handles it next).
 *
 * Returns the pipeline-text segments and the operators between them. Empty segments
 * (e.g. `a &&`, `&& b`, `a &&&& b`, `; ;`) throw.
 */
function splitOnChainOperators(commandLine: string): {
    readonly pipelines: readonly string[];
    readonly operators: readonly ChainOperator[];
} {
    const pipelines: string[] = [];
    const operators: ChainOperator[] = [];
    const current: string[] = [];
    let quote: '"' | "'" | null = null;
    for (let index = 0; index < commandLine.length; index += 1) {
        const char = commandLine[index];
        if (char === undefined) {
            continue;
        }
        if (quote !== null) {
            current.push(char);
            if (char === quote) {
                quote = null;
            }
            if (char === '\\' && quote === '"') {
                const next = commandLine[index + 1];
                if (next !== undefined) {
                    current.push(next);
                    index += 1;
                }
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            current.push(char);
            continue;
        }
        if (char === '\\') {
            const next = commandLine[index + 1];
            if (next === undefined) {
                throw denied('trailing escape is denied');
            }
            current.push(char, next);
            index += 1;
            continue;
        }
        const next = commandLine[index + 1];
        if (char === '&' && next === '&') {
            pipelines.push(current.splice(0).join(''));
            operators.push('&&');
            index += 1;
            continue;
        }
        if (char === '|' && next === '|') {
            pipelines.push(current.splice(0).join(''));
            operators.push('||');
            index += 1;
            continue;
        }
        if (char === ';') {
            pipelines.push(current.splice(0).join(''));
            operators.push(';');
            continue;
        }
        current.push(char);
    }
    pipelines.push(current.join(''));
    if (pipelines.length > 1) {
        for (const segment of pipelines) {
            if (segment.trim().length === 0) {
                throw denied('empty chain segment is denied');
            }
        }
    }
    return { pipelines, operators };
}

/**
 * Parse a command line that may contain top-level chain operators (`&&`, `||`, `;`) and pipe
 * operators (`|`) within each chain segment. Each pipeline segment is independently split on
 * `|`, tokenized, and policy-checked. The chain operators are enforced by direct-spawn
 * exit-code branching in the executor — NO shell is ever invoked.
 *
 * Security invariant: every leaf argv is spawned with `child_process.spawn(cmd, args, { shell:
 * false })`. Chain operators and pipes are pure Node-side control flow (split + per-argv policy
 * check + exit-code branching + stdio piping). A lone `&`, `<`, `>`, `(`, `)`, `{`, `}`, `$`,
 * backtick, or newline still trips the per-token forbidden-character guard inside each segment.
 *
 * Empty chain segments (e.g. `a &&`, `&& b`, `; ;`) and empty pipe segments (e.g. `a |`) are
 * rejected. A single-pipeline input with no chain operator behaves identically to
 * `parseTrustedCommandPipeline`.
 */
export function parseTrustedCommandChain(commandLine: string): CommandChain {
    if (commandLine.includes('\0')) {
        throw denied('null bytes are denied');
    }
    const { pipelines: pipelineTexts, operators } = splitOnChainOperators(commandLine);
    if (pipelineTexts.length === 0) {
        throw denied('empty shell input is denied');
    }
    const pipelines: (readonly (readonly string[])[])[] = pipelineTexts.map((text) => {
        const segments = splitOnPipe(text);
        return segments.map((segment) => {
            const argv = tokenizeShellWords(segment);
            enforceTrustedCommandPolicy(argv);
            return argv;
        });
    });
    return { pipelines, operators };
}
