// allow: SIZE_OK — task 11 spec mandates a single file at this exact path; module
// owns one cohesive concept (ast-grep CLI wrapper). Sibling file-edit-fuzzy.ts (410
// pure LOC) and read-tools.ts (326) set the project norm for cohesive tool modules.
/**
 * ast-grep CLI runner (Wave 4, task 11).
 *
 * Wraps the `sg` / `ast-grep` / `npx @ast-grep/cli` binary for structural code
 * search. The binary is detected at runtime - this package does NOT depend on
 * `@ast-grep/cli`. Binary detection and command execution are exposed as
 * injectable seams so unit tests can mock them without spawning processes.
 *
 * Output contract: `sg run --json` emits a JSON array of matches with 0-indexed
 * line/column. This runner normalises to 1-indexed positions, flattens
 * `metaVariables` into a `Record<string,string>` (multi-vars joined with `\n`),
 * and surfaces both stderr parse-error lines and match-limit truncation notices
 * through `AstGrepResult.parseErrors`.
 */
import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public result types (locked by task spec)
// ---------------------------------------------------------------------------

export type AstGrepMatch = {
    readonly path: string;
    readonly text: string;
    readonly startLine: number; // 1-indexed
    readonly startColumn: number; // 1-indexed
    readonly endLine: number;
    readonly endColumn: number;
    readonly metaVariables?: Readonly<Record<string, string>>;
};

export type AstGrepResult = {
    readonly matches: readonly AstGrepMatch[];
    readonly filesSearched: number;
    readonly filesWithMatches: number;
    readonly parseErrors?: readonly string[];
};

export type AstGrepRunOptions = {
    readonly pattern: string;
    readonly paths: readonly string[];
    readonly language?: string;
    readonly cwd: string;
    readonly signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export type BinaryResolution = {
    /** Executable to spawn: `sg`, `ast-grep`, or `npx`. */
    readonly command: string;
    /** Args prepended before the ast-grep subcommand. Empty for native binaries. */
    readonly prefixArgs: readonly string[];
};

export type BinaryDetector = (signal: AbortSignal) => Promise<BinaryResolution | undefined>;

export type AstGrepCommandExecParams = {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
};

export type AstGrepCommandExecResult = {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly aborted: boolean;
};

export type AstGrepCommandExecutor = (params: AstGrepCommandExecParams) => Promise<AstGrepCommandExecResult>;

export type AstGrepRunnerDependencies = {
    readonly detectBinary: BinaryDetector;
    readonly execute: AstGrepCommandExecutor;
    readonly matchLimit: number;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
};

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type AstGrepRunnerErrorCode = 'not_installed' | 'timed_out' | 'aborted' | 'run_failed' | 'invalid_input';

export class AstGrepRunnerError extends Error {
    readonly code: AstGrepRunnerErrorCode;
    readonly stderr?: string;

    constructor(code: AstGrepRunnerErrorCode, message: string, stderr?: string) {
        super(message);
        this.name = 'AstGrepRunnerError';
        this.code = code;
        if (stderr !== undefined) {
            this.stderr = stderr;
        }
    }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MATCH_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const NOT_INSTALLED_MESSAGE = 'ast-grep is not installed. Install with: npm install -g @ast-grep/cli';

const BINARY_CANDIDATES: readonly BinaryResolution[] = [
    { command: 'sg', prefixArgs: [] },
    { command: 'ast-grep', prefixArgs: [] },
    { command: 'npx', prefixArgs: ['-y', '@ast-grep/cli'] },
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAstGrep(
    options: AstGrepRunOptions,
    deps?: Partial<AstGrepRunnerDependencies>,
): Promise<AstGrepResult> {
    if (options.pattern.length === 0) {
        throw new AstGrepRunnerError('invalid_input', 'ast-grep pattern must be non-empty');
    }
    if (options.paths.length === 0) {
        throw new AstGrepRunnerError('invalid_input', 'ast-grep paths must contain at least one entry');
    }
    const resolved: AstGrepRunnerDependencies = {
        detectBinary: deps?.detectBinary ?? defaultBinaryDetector,
        execute: deps?.execute ?? defaultAstGrepExecutor,
        matchLimit: deps?.matchLimit ?? DEFAULT_MATCH_LIMIT,
        timeoutMs: deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: deps?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    };
    const signal = options.signal ?? freshAbortController().signal;
    const binary = await resolved.detectBinary(signal);
    if (binary === undefined) {
        throw new AstGrepRunnerError('not_installed', NOT_INSTALLED_MESSAGE);
    }
    const { command, args } = buildAstGrepCommand(binary, options);
    const result = await resolved.execute({
        command,
        args,
        cwd: options.cwd,
        maxOutputBytes: resolved.maxOutputBytes,
        timeoutMs: resolved.timeoutMs,
        signal,
    });
    if (result.timedOut) {
        throw new AstGrepRunnerError('timed_out', `ast-grep timed out after ${resolved.timeoutMs}ms`, result.stderr);
    }
    if (result.aborted) {
        throw new AstGrepRunnerError('aborted', 'ast-grep aborted before completion', result.stderr);
    }
    // ast-grep follows grep's exit-code convention: 0 means matches found, 1 means no
    // matches found. Codes >= 2 (and a null code when the process died without an exit
    // status) indicate a genuine run failure. Accept 0 and 1 as completed runs and let
    // stdout parsing authoritatively describe the result set.
    if (result.exitCode === null || result.exitCode > 1) {
        throw new AstGrepRunnerError(
            'run_failed',
            `ast-grep exited with code ${result.exitCode ?? 'null'}${describeStderr(result.stderr)}`,
            result.stderr,
        );
    }
    return parseAstGrepOutput(result.stdout, result.stderr, resolved.matchLimit);
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

function buildAstGrepCommand(
    binary: BinaryResolution,
    options: AstGrepRunOptions,
): { readonly command: string; readonly args: readonly string[] } {
    const args: string[] = [...binary.prefixArgs, 'run', '--json'];
    if (options.language !== undefined && options.language.length > 0) {
        args.push('--lang', options.language);
    }
    // ast-grep >= 0.30 requires the pattern behind the --pattern flag; the positional
    // pattern slot was removed and positional args are now search paths only.
    args.push('--pattern', options.pattern);
    for (const path of options.paths) {
        args.push(path);
    }
    return { command: binary.command, args };
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

type RawPosition = { readonly line?: number; readonly column?: number };
type RawRange = { readonly start?: RawPosition; readonly end?: RawPosition };
type RawAstGrepMatch = {
    readonly text?: string;
    readonly file?: string;
    readonly path?: string;
    readonly range?: RawRange;
    readonly metaVariables?: Readonly<Record<string, unknown>>;
    readonly meta_variables?: Readonly<Record<string, unknown>>;
};

function parseAstGrepOutput(stdout: string, stderr: string, matchLimit: number): AstGrepResult {
    const parseErrors = collectParseErrors(stderr);
    const raw = parseJsonArray(stdout);
    if (raw === undefined) {
        return emptyResult(parseErrors);
    }
    const matches: AstGrepMatch[] = [];
    const filesWithMatches = new Set<string>();
    for (const entry of raw) {
        const normalized = normalizeMatch(entry);
        if (normalized === undefined) continue;
        matches.push(normalized);
        filesWithMatches.add(normalized.path);
    }
    if (matches.length > matchLimit) {
        const dropped = matches.length - matchLimit;
        matches.length = matchLimit;
        parseErrors.push(`result_truncated: ${dropped} additional match(es) dropped after limit of ${matchLimit}`);
    }
    return {
        matches,
        filesSearched: filesWithMatches.size,
        filesWithMatches: filesWithMatches.size,
        ...(parseErrors.length > 0 ? { parseErrors } : {}),
    };
}

function emptyResult(parseErrors: readonly string[]): AstGrepResult {
    return {
        matches: [],
        filesSearched: 0,
        filesWithMatches: 0,
        ...(parseErrors.length > 0 ? { parseErrors } : {}),
    };
}

function collectParseErrors(stderr: string): string[] {
    const trimmed = stderr.trim();
    if (trimmed.length === 0) return [];
    const errors: string[] = [];
    for (const line of trimmed.split('\n')) {
        const candidate = line.trim();
        if (candidate.length === 0) continue;
        if (isParseErrorLine(candidate)) {
            errors.push(candidate);
        }
    }
    return errors;
}

function isParseErrorLine(line: string): boolean {
    const lowered = line.toLowerCase();
    return (
        lowered.includes('parse error') ||
        lowered.includes('error nodes') ||
        lowered.startsWith('warning:') ||
        lowered.startsWith('error:')
    );
}

function parseJsonArray(stdout: string): readonly RawAstGrepMatch[] | undefined {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return [];
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return Array.isArray(parsed) ? (parsed as readonly RawAstGrepMatch[]) : undefined;
    } catch {
        return undefined;
    }
}

function normalizeMatch(entry: RawAstGrepMatch): AstGrepMatch | undefined {
    const path = entry.file ?? entry.path;
    const range = entry.range;
    const start = range?.start;
    const end = range?.end;
    const startLine = start?.line;
    const startColumn = start?.column;
    if (path === undefined || path.length === 0 || startLine === undefined || startColumn === undefined) {
        return undefined;
    }
    const endLine = end?.line ?? startLine;
    const endColumn = end?.column ?? startColumn;
    const metaVariables = normalizeMetaVariables(entry.metaVariables ?? entry.meta_variables);
    return {
        path,
        text: entry.text ?? '',
        startLine: startLine + 1,
        startColumn: startColumn + 1,
        endLine: endLine + 1,
        endColumn: endColumn + 1,
        ...(metaVariables !== undefined ? { metaVariables } : {}),
    };
}

function normalizeMetaVariables(
    source: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> | undefined {
    if (source === undefined) return undefined;
    // ast-grep >= 0.7 emits a nested { single, multi, transformed } envelope where each
    // captured value is a tree-sitter node ({ text, range }). Earlier versions (and the
    // mocked unit tests) emit a flat { NAME: value } map. Route to the matching parser.
    if (hasNestedMetaEnvelope(source)) {
        return normalizeNestedMetaVariables(source);
    }
    return normalizeFlatMetaVariables(source);
}

function hasNestedMetaEnvelope(source: Readonly<Record<string, unknown>>): boolean {
    return isRecordValue(source['single']) || isRecordValue(source['multi']);
}

function normalizeNestedMetaVariables(
    source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> | undefined {
    const out: Record<string, string> = {};
    const single = source['single'];
    if (isRecordValue(single)) {
        for (const [name, node] of Object.entries(single)) {
            const text = nodeText(node);
            if (text !== undefined) out[name] = text;
        }
    }
    const multi = source['multi'];
    if (isRecordValue(multi)) {
        for (const [name, nodes] of Object.entries(multi)) {
            const joined = multiNodeText(nodes);
            if (joined !== undefined) out[name] = joined;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeFlatMetaVariables(
    source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> | undefined {
    const out: Record<string, string> = {};
    let populated = false;
    for (const [key, value] of Object.entries(source)) {
        // Flat envelopes may carry node-shaped values ({ text, range }) in some versions;
        // prefer .text, otherwise fall back to scalar serialization.
        const extracted = nodeText(value) ?? serializeMetaValue(value);
        if (extracted !== undefined) {
            out[key] = extracted;
            populated = true;
        }
    }
    return populated ? out : undefined;
}

function isRecordValue(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeText(node: unknown): string | undefined {
    if (!isRecordValue(node)) return undefined;
    const text = node['text'];
    return typeof text === 'string' ? text : undefined;
}

function multiNodeText(nodes: unknown): string | undefined {
    if (!Array.isArray(nodes)) return undefined;
    const parts: string[] = [];
    for (const node of nodes) {
        const text = nodeText(node);
        if (text !== undefined) parts.push(text);
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
}

function serializeMetaValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        const parts = value.map(serializeMetaValue).filter((v): v is string => v !== undefined);
        return parts.length > 0 ? parts.join('\n') : undefined;
    }
    return undefined;
}

function describeStderr(stderr: string): string {
    const trimmed = stderr.trim();
    return trimmed.length > 0 ? `: ${trimmed}` : '';
}

// ---------------------------------------------------------------------------
// Default binary detection
// ---------------------------------------------------------------------------

export const defaultBinaryDetector: BinaryDetector = async (signal): Promise<BinaryResolution | undefined> => {
    for (const candidate of BINARY_CANDIDATES) {
        if (await isBinaryAvailable(candidate.command, signal)) {
            return candidate;
        }
    }
    return undefined;
};

function isBinaryAvailable(command: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        const settle = (value: boolean): void => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };
        let child: ReturnType<typeof execFile>;
        try {
            child = execFile(command, ['--version'], { windowsHide: true }, (error, stdout) => {
                if (error !== null) {
                    settle(false);
                    return;
                }
                settle(stdout !== undefined && stdout.trim().length > 0);
            });
        } catch {
            settle(false);
            return;
        }
        child.on('error', () => settle(false));
        signal.addEventListener(
            'abort',
            () => {
                try {
                    child.kill('SIGTERM');
                } catch {
                    // Process already gone; the callback will settle with error.
                }
                settle(false);
            },
            { once: true },
        );
    });
}

// ---------------------------------------------------------------------------
// Default command executor (uses node:child_process execFile, async)
// ---------------------------------------------------------------------------

export const defaultAstGrepExecutor: AstGrepCommandExecutor = (params): Promise<AstGrepCommandExecResult> => {
    return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let escalateTimer: ReturnType<typeof setTimeout> | undefined;
        const settle = (outcome: AstGrepCommandExecResult): void => {
            if (settled) return;
            settled = true;
            if (killTimer !== undefined) clearTimeout(killTimer);
            if (escalateTimer !== undefined) clearTimeout(escalateTimer);
            resolve(outcome);
        };
        let child: ReturnType<typeof execFile>;
        try {
            child = execFile(
                params.command,
                [...params.args],
                {
                    cwd: params.cwd,
                    maxBuffer: params.maxOutputBytes,
                    windowsHide: true,
                },
                (error, stdout, stderr) => {
                    if (error === null) {
                        settle({
                            stdout: stdout ?? '',
                            stderr: stderr ?? '',
                            exitCode: 0,
                            timedOut: false,
                            aborted: params.signal.aborted,
                        });
                        return;
                    }
                    const err = error as NodeJS.ErrnoException & { code?: number | string };
                    const exitCode = typeof err.code === 'number' ? err.code : null;
                    settle({
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                        exitCode,
                        timedOut,
                        aborted: params.signal.aborted,
                    });
                },
            );
        } catch (error: unknown) {
            settle({
                stdout: '',
                stderr: errorMessage(error),
                exitCode: null,
                timedOut: false,
                aborted: params.signal.aborted,
            });
            return;
        }
        child.on('error', (error: Error) =>
            settle({
                stdout: '',
                stderr: errorMessage(error),
                exitCode: null,
                timedOut: false,
                aborted: params.signal.aborted,
            }),
        );
        killTimer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill('SIGTERM');
            } catch {
                // ignore
            }
            escalateTimer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // ignore
                }
            }, 1000);
        }, params.timeoutMs);
        params.signal.addEventListener(
            'abort',
            () => {
                try {
                    child.kill('SIGTERM');
                } catch {
                    // ignore
                }
            },
            { once: true },
        );
    });
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function freshAbortController(): AbortController {
    return new AbortController();
}
