// Adapted from opencode (MIT). Upstream source:
//   https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/shell.ts (lines ~91-218)
// Copyright (c) 2025 opencode. The upstream parses a bash command with a
// tree-sitter grammar and walks the AST to propose file paths for permission
// prompting. This port is plain TypeScript (no effect-runtime, no wasm grammar):
// it operates on the already-tokenized argv that bash.run / command.run hand it,
// which is safe because the bash.run command guard rejects shell expansions and
// control operators before this runs. The fixed allowlist in command-run-policy
// stays as the fallback; this module only PROPOSES candidate paths so a human
// can approve by file scope rather than by exact command string. It never throws
// (defense in depth): on malformed or dynamic input it returns an empty list and
// the caller falls back to the full command as the sole permission pattern.

import { homedir } from 'node:os';
import { basename } from 'node:path';

/**
 * Commands whose positional (non-flag) arguments are file paths. Mirrors the
 * opencode `FILES` / `CWD` sets. `cd` family included so directory-scoped
 * approval is proposed for cwd changes too.
 */
const FILE_PATH_COMMANDS = new Set<string>([
    'cat',
    'cp',
    'mv',
    'rm',
    'mkdir',
    'touch',
    'chmod',
    'chown',
    'head',
    'tail',
    'less',
    'more',
    'ln',
    'stat',
    'file',
    'tee',
    'dd',
    'install',
    'truncate',
    'shred',
    'basename',
    'dirname',
    'realpath',
    'readlink',
    'cd',
    'chdir',
    'pushd',
    'popd',
]);

/**
 * Strip a single layer of matching surrounding quotes. Non-quoted or
 * mismatched text is returned unchanged.
 */
export function unquote(text: string): string {
    if (text.length < 2) {
        return text;
    }
    const first = text[0];
    const last = text[text.length - 1];
    if (first === undefined || last === undefined) {
        return text;
    }
    if ((first === '"' || first === "'") && first === last) {
        return text.slice(1, -1);
    }
    return text;
}

/**
 * Expand a leading `~` to the user home directory. `~` alone and `~/...` (or
 * `~\...` on Windows) are expanded; everything else is returned unchanged.
 */
export function expandHome(text: string): string {
    if (text === '~') {
        return homedir();
    }
    if (text.startsWith('~/') || text.startsWith('~\\')) {
        return `${homedir()}${text.slice(1)}`;
    }
    return text;
}

/**
 * True when the token contains a shell substitution the guard cannot resolve
 * statically (`$(`, `${`, backtick, or a bare `$`). Such tokens are skipped
 * because their resolved value is unknowable at prompt time.
 */
export function isDynamic(text: string): boolean {
    return text.includes('$(') || text.includes('${') || text.includes('`') || text.includes('$');
}

/**
 * Return the literal prefix of a glob token (everything before the first glob
 * metacharacter `?`, `*`, or `[`). Returns null when the token starts with a
 * metacharacter (no literal prefix) so the caller can skip it.
 */
export function globPrefix(text: string): string | null {
    const match = /[?*[]/u.exec(text);
    if (match === null) {
        return text;
    }
    if (match.index === 0) {
        return null;
    }
    return text.slice(0, match.index);
}

function isFlag(arg: string): boolean {
    return arg.startsWith('-');
}

function isChmodMode(arg: string, command: string): boolean {
    return command === 'chmod' && arg.startsWith('+');
}

/**
 * Normalize a single positional argument into a candidate file path, or null
 * when it should be skipped (flag, dynamic substitution, pure glob, empty).
 */
function normalizePathArg(arg: string, command: string): string | null {
    if (isFlag(arg) || isChmodMode(arg, command)) {
        return null;
    }
    const unquoted = unquote(arg);
    if (unquoted.length === 0) {
        return null;
    }
    if (isDynamic(unquoted)) {
        return null;
    }
    const expanded = expandHome(unquoted);
    const prefix = globPrefix(expanded);
    if (prefix === null || prefix.length === 0) {
        return null;
    }
    return prefix;
}

/**
 * Extract candidate file paths from a single already-tokenized command. Returns
 * the positional path arguments for commands in {@link FILE_PATH_COMMANDS};
 * returns an empty list for every other command, for empty argv, or when no
 * argument survives normalization. Never throws.
 *
 * Example: `['cat', 'foo.txt', 'bar.ts']` -> `['foo.txt', 'bar.ts']`.
 */
export function extractFilePaths(argv: readonly string[]): readonly string[] {
    if (argv.length === 0) {
        return [];
    }
    const rawCommand = argv[0];
    if (rawCommand === undefined) {
        return [];
    }
    const command = basename(rawCommand).toLowerCase();
    if (!FILE_PATH_COMMANDS.has(command)) {
        return [];
    }
    const paths: string[] = [];
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined) {
            continue;
        }
        const normalized = normalizePathArg(arg, command);
        if (normalized !== null) {
            paths.push(normalized);
        }
    }
    return paths;
}

/**
 * Structured-input variant for `command.run`, which receives the command and
 * its args separately. Equivalent to `extractFilePaths([command, ...args])`.
 */
export function extractPermissionPaths(command: string, args: readonly string[]): readonly string[] {
    return extractFilePaths([command, ...args]);
}

export { FILE_PATH_COMMANDS };
