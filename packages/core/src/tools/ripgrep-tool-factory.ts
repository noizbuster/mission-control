/**
 * Workspace-scoped `ripgrep` factory.
 *
 * The static `ripgrepToolRegistration` throws on execute because it has no workspace guard. This
 * factory mirrors `createGlobToolRegistration` + the read-tools guard: it pins the search base to
 * the workspace root, rejects absolute and symlink-escape targets, applies the SAME denylist the
 * read tools use (so `node_modules`, `dist`, and other generated paths are filtered out), and
 * stays read-class. The tool name stays `ripgrep`.
 *
 * Backend fallback chain (mc convention):
 *
 *   1. `rg`     — ripgrep. Preferred. JSON-free, line-based parsing.
 *   2. `grep`   — GNU grep. Falls back when rg is not on PATH.
 *   3. `node`   — pure-JS RegExp walker. Always available.
 *
 * The chain is per-call: a runtime spawn failure for the resolved backend marks that backend
 * skipped and re-resolves to the next tier. Resolution is cached per process (see `ripgrep-cli.ts`).
 *
 * Exit code semantics (rg/grep):
 *   - 0 → matches found
 *   - 1 → no matches (treated as a successful empty result)
 *   - 2+ → error (re-throw as structured `error`)
 */
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { spawn } from 'node:child_process';
import { readdir, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
    formatRipgrepModelOutput,
    type RipgrepMatch,
    type RipgrepOutputMode,
    type RipgrepToolInput,
    type RipgrepToolOutput,
    ripgrepInputSchema,
    ripgrepOutputLimit,
    ripgrepOutputSchema,
    ripgrepParametersJsonSchema,
    RIPGREP_DEFAULT_HEAD_LIMIT,
    RIPGREP_DEFAULT_MAX_OUTPUT_BYTES,
    RIPGREP_DEFAULT_TIMEOUT_MS,
} from './ripgrep-tool';
import {
    resetSearchCliCacheForTests,
    reresolveSearchCliSkipping,
    resolveSearchCli,
    type ResolvedSearchCli,
    type SearchBackend,
} from './ripgrep-cli';
import { repoToolFailure } from './read-tools-errors';
import { isBinarySample, createWorkspaceGuard, type WorkspaceGuard } from './read-tools-paths';
import { permissionRequest, requestToolPermission } from './tool-permissions';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry';

export type RipgrepToolFactoryOptions = {
    readonly workspaceRoot: string;
    readonly requestPermission?: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
};

export async function registerRipgrepTool(
    registry: ToolRegistry,
    options: RipgrepToolFactoryOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createRipgrepToolRegistration(options));
}

export async function createRipgrepToolRegistration(
    options: RipgrepToolFactoryOptions,
): Promise<ToolRegistration<RipgrepToolInput, RipgrepToolOutput>> {
    const guard = await createWorkspaceGuard(options.workspaceRoot);
    return {
        name: 'ripgrep',
        description:
            'Fast content search tool with safety limits (60s timeout, 256KB output). Searches file contents using regular expressions via ripgrep with grep and pure-JS fallback. Supports --include glob filtering and three output modes: "content" (matching lines), "files_with_matches" (file paths only, default), "count" (per-file match counts).',
        capabilityClasses: ['read'],
        parametersJsonSchema: ripgrepParametersJsonSchema,
        inputSchema: ripgrepInputSchema,
        outputSchema: ripgrepOutputSchema,
        outputLimit: ripgrepOutputLimit,
        guideline:
            'Use ripgrep to locate content (function definitions, error strings, config keys) before reading files. Bases are workspace-relative; paths under generated/reference directories are filtered out. Prefer `output_mode: "files_with_matches"` for the first pass, then narrow with `include` or `output_mode: "content"`.',
        execute: (input, context) => runWorkspaceRipgrep(guard, options, input, context.toolCallId, context.toolName),
        toModelOutput: formatRipgrepModelOutput,
    };
}

async function runWorkspaceRipgrep(
    guard: WorkspaceGuard,
    options: RipgrepToolFactoryOptions,
    input: RipgrepToolInput,
    toolCallId: string,
    toolName: string,
): Promise<RipgrepToolOutput> {
    await requireReadPermission(options, toolCallId, toolName, input.path ?? '.');
    const target = await resolveRipgrepBase(guard, input.path);
    const outputMode: RipgrepOutputMode = input.output_mode ?? 'files_with_matches';
    const headLimit = input.head_limit ?? RIPGREP_DEFAULT_HEAD_LIMIT;
    const matches = await runSearchChain(guard, input, outputMode, target.absolutePath);
    const sliced = matches.slice(0, headLimit);
    const filesSearched = new Set(sliced.map((match) => match.path)).size;
    return {
        outputMode,
        matches: sliced,
        filesSearched,
        truncated: matches.length > headLimit,
    };
}

/**
 * Drive the rg → grep → node chain. Each spawn-based tier can mark itself
 * unavailable (ENOENT-style) via the spawn-error path; re-resolve and try the
 * next tier. The pure-JS tier always succeeds.
 */
async function runSearchChain(
    guard: WorkspaceGuard,
    input: RipgrepToolInput,
    outputMode: RipgrepOutputMode,
    targetPath: string,
): Promise<readonly RipgrepMatch[]> {
    let cli = resolveSearchCli();
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (cli.backend === 'node') {
            return searchWithNode(guard, targetPath, input, outputMode);
        }
        const result = await runCliSpawn(cli, guard, input, outputMode, targetPath);
        if (result.kind === 'ok') {
            return result.matches;
        }
        if (result.kind === 'spawn_failed') {
            cli = reresolveSearchCliSkipping(cli.backend);
            continue;
        }
        throw repoToolFailure('search_failed', result.error);
    }
    return searchWithNode(guard, targetPath, input, outputMode);
}

type CliSpawnResult =
    | { readonly kind: 'ok'; readonly matches: readonly RipgrepMatch[] }
    | { readonly kind: 'spawn_failed' }
    | { readonly kind: 'runtime_error'; readonly error: string };

async function runCliSpawn(
    cli: ResolvedSearchCli,
    guard: WorkspaceGuard,
    input: RipgrepToolInput,
    outputMode: RipgrepOutputMode,
    targetPath: string,
): Promise<CliSpawnResult> {
    if (cli.backend === 'node' || cli.path === null) {
        return { kind: 'spawn_failed' };
    }
    const args = cli.backend === 'rg' ? buildRgArgs(guard, input, outputMode) : buildGrepArgs(guard, input, outputMode);
    const patternArg = cli.backend === 'rg' ? ['--', input.pattern] : ['-e', input.pattern];
    const fullArgs = [...args, ...patternArg, targetPath];
    const spawnResult = await runProcess(cli.path, fullArgs);
    if (spawnResult.error !== undefined) {
        if (isENOENT(spawnResult.error)) {
            return { kind: 'spawn_failed' };
        }
        return { kind: 'runtime_error', error: spawnResult.error };
    }
    const parsed = parseRipgrepOutput(spawnResult.stdout, outputMode, guard);
    return { kind: 'ok', matches: parsed };
}

function buildRgArgs(
    guard: WorkspaceGuard,
    input: RipgrepToolInput,
    outputMode: RipgrepOutputMode,
): readonly string[] {
    const args: string[] = [
        '--color=never',
        '--no-heading',
        '--line-number',
        '--with-filename',
        '--no-messages',
        '--hidden',
    ];
    for (const glob of guard.denylistRipgrepGlobs) {
        args.push('--glob', glob);
    }
    if (input.include !== undefined) {
        args.push('--glob', input.include);
    }
    if (outputMode === 'files_with_matches') {
        args.push('--files-with-matches');
    } else if (outputMode === 'count') {
        args.push('--count');
    }
    return args;
}

/**
 * GNU grep args matching the rg output shape as closely as possible:
 *   - `-r` recursive
 *   - `-E` extended regex (closer to rg's default syntax)
 *   - `-n` line numbers, `-H` always print filename
 *   - `--include=<glob>` per-file filter
 *   - `--exclude-dir=<dir>` per denylist entry
 *   - `-l` for files_with_matches, `-c` for count
 *
 * rg's `--glob '!path'` syntax is not understood by grep, so the denylist is
 * translated to `--exclude-dir` (one entry per directory in the denylist).
 */
function buildGrepArgs(
    guard: WorkspaceGuard,
    input: RipgrepToolInput,
    outputMode: RipgrepOutputMode,
): readonly string[] {
    const args: string[] = ['-r', '-E', '-n', '-H', '--color=never'];
    for (const dir of denylistDirectories(guard)) {
        args.push(`--exclude-dir=${dir}`);
    }
    if (input.include !== undefined) {
        args.push(`--include=${input.include}`);
    }
    if (outputMode === 'files_with_matches') {
        args.push('-l');
    } else if (outputMode === 'count') {
        args.push('-c');
    }
    return args;
}

function denylistDirectories(guard: WorkspaceGuard): readonly string[] {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const glob of guard.denylistRipgrepGlobs) {
        if (!glob.startsWith('!')) continue;
        const trimmed = glob.slice(1).replace(/\/\*+$/, '');
        if (trimmed.length === 0 || trimmed.includes('*') || trimmed.includes('/')) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        dirs.push(trimmed);
    }
    return dirs;
}

type ProcessResult =
    | { readonly stdout: string; readonly error?: undefined }
    | { readonly stdout: ''; readonly error: string };

async function runProcess(command: string, args: readonly string[]): Promise<ProcessResult> {
    return await new Promise((resolvePromise) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                child.kill('SIGKILL');
            } catch {
                /* best-effort kill */
            }
            resolvePromise({ stdout: '', error: `${command} timeout after ${RIPGREP_DEFAULT_TIMEOUT_MS}ms` });
        }, RIPGREP_DEFAULT_TIMEOUT_MS);

        child.stdout.on('data', (chunk: Buffer) => {
            const total = stdoutChunks.reduce((sum, buffer) => sum + buffer.length, 0);
            if (total >= RIPGREP_DEFAULT_MAX_OUTPUT_BYTES) return;
            const remaining = RIPGREP_DEFAULT_MAX_OUTPUT_BYTES - total;
            if (chunk.length > remaining) {
                stdoutChunks.push(chunk.subarray(0, remaining));
            } else {
                stdoutChunks.push(chunk);
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk);
        });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolvePromise({
                stdout: '',
                error: `${command} spawn failed: ${error instanceof Error ? error.message : String(error)}`,
            });
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
            // rg/grep exit codes: 0 = matches, 1 = no matches, 2+ = error.
            if (code !== null && code > 1 && stderr.length > 0) {
                resolvePromise({ stdout: '', error: stderr });
                return;
            }
            resolvePromise({ stdout: Buffer.concat(stdoutChunks).toString('utf8') });
        });
    });
}

function parseRipgrepOutput(
    stdout: string,
    outputMode: RipgrepOutputMode,
    guard: WorkspaceGuard,
): readonly RipgrepMatch[] {
    if (stdout.trim().length === 0) {
        return [];
    }
    const lines = stdout.split('\n');
    const matches: RipgrepMatch[] = [];
    for (const line of lines) {
        const normalized = line.replace(/\r$/, '');
        if (normalized.length === 0) {
            continue;
        }
        if (outputMode === 'files_with_matches') {
            const trimmed = normalized.trim();
            if (guard.isDeniedAbsolutePath(trimmed)) {
                continue;
            }
            matches.push({ path: guard.relativeFromAbsolute(trimmed), line: 0, text: '' });
            continue;
        }
        if (outputMode === 'count') {
            const match = normalized.match(/^([A-Za-z]:[\\\/].*?|.+?):(\d+)(?=:|$)/);
            if (match === null || match[1] === undefined || match[2] === undefined) {
                continue;
            }
            const absolute = match[1];
            const count = parseInt(match[2], 10);
            if (Number.isNaN(count) || guard.isDeniedAbsolutePath(absolute)) {
                continue;
            }
            matches.push({ path: guard.relativeFromAbsolute(absolute), line: count, text: '' });
            continue;
        }
        const match = normalized.match(/^([A-Za-z]:[\\\/].*?|.+?):(\d+):(.*)$/);
        if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
            continue;
        }
        const absolute = match[1];
        const lineNumber = parseInt(match[2], 10);
        const text = match[3];
        if (Number.isNaN(lineNumber) || guard.isDeniedAbsolutePath(absolute)) {
            continue;
        }
        matches.push({ path: guard.relativeFromAbsolute(absolute), line: lineNumber, text });
    }
    return matches;
}

/**
 * Pure-JS fallback. Walks the target directory with the same `WorkspaceGuard`
 * semantics as `searchRepoText` in `read-tools-search.ts`, compiles the pattern
 * as a JS RegExp, and emits the same `RipgrepMatch[]` shape the rg/grep tiers
 * produce. Always available; used when neither binary is on PATH or both fail.
 */
async function searchWithNode(
    guard: WorkspaceGuard,
    targetPath: string,
    input: RipgrepToolInput,
    outputMode: RipgrepOutputMode,
): Promise<readonly RipgrepMatch[]> {
    const files = await collectFiles(guard, targetPath);
    const filtered = input.include !== undefined ? filterByInclude(files, input.include) : files;
    let regex: RegExp;
    try {
        regex = new RegExp(input.pattern, 'u');
    } catch (error) {
        throw repoToolFailure(
            'search_failed',
            `invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const matches: RipgrepMatch[] = [];
    for (const file of filtered) {
        let bytes: Buffer;
        try {
            bytes = await readFile(file);
        } catch {
            continue;
        }
        if (isBinarySample(bytes.subarray(0, 4096))) {
            continue;
        }
        const lines = bytes.toString('utf8').split(/\r?\n/);
        let fileCount = 0;
        let firstMatch: RipgrepMatch | undefined;
        for (const [index, text] of lines.entries()) {
            if (!regex.test(text)) {
                continue;
            }
            fileCount += 1;
            if (outputMode === 'files_with_matches') {
                if (firstMatch === undefined) {
                    firstMatch = { path: guard.relativeFromAbsolute(file), line: 0, text: '' };
                }
                break;
            }
            if (outputMode === 'count') {
                continue;
            }
            matches.push({
                path: guard.relativeFromAbsolute(file),
                line: index + 1,
                text,
            });
        }
        if (outputMode === 'files_with_matches' && firstMatch !== undefined) {
            matches.push(firstMatch);
        } else if (outputMode === 'count' && fileCount > 0) {
            matches.push({ path: guard.relativeFromAbsolute(file), line: fileCount, text: '' });
        }
    }
    return matches;
}

async function collectFiles(guard: WorkspaceGuard, rootPath: string): Promise<readonly string[]> {
    let stats;
    try {
        stats = await realpath(rootPath);
    } catch {
        return [];
    }
    const entries: string[] = [];
    await walk(stats, guard, entries);
    return entries.sort((left, right) => left.localeCompare(right));
}

async function walk(currentPath: string, guard: WorkspaceGuard, out: string[]): Promise<void> {
    let directoryEntries;
    try {
        directoryEntries = await readdir(currentPath, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of directoryEntries) {
        const absolute = join(currentPath, entry.name);
        if (!guard.shouldTraverseAbsolutePath(absolute)) {
            continue;
        }
        if (entry.isDirectory()) {
            await walk(absolute, guard, out);
            continue;
        }
        if (entry.isFile()) {
            out.push(absolute);
        }
    }
}

function filterByInclude(files: readonly string[], include: string): readonly string[] {
    const matcher = includeGlobToRegExp(include);
    return files.filter((file) => matcher.test(file));
}

function includeGlobToRegExp(include: string): RegExp {
    let regex = '';
    for (const char of include) {
        if (char === '*') {
            regex += '.*';
        } else if (char === '?') {
            regex += '.';
        } else if (isRegExpSpecial(char)) {
            regex += `\\${char}`;
        } else {
            regex += char;
        }
    }
    return new RegExp(`${regex}$`);
}

function isRegExpSpecial(char: string): boolean {
    return '.+()|{}[]^$\\'.includes(char);
}

async function resolveRipgrepBase(guard: WorkspaceGuard, requestedPath: string | undefined): Promise<{
    readonly absolutePath: string;
    readonly relativePath: string;
}> {
    if (requestedPath === undefined || requestedPath.length === 0) {
        return { absolutePath: guard.root, relativePath: '.' };
    }
    if (isAbsolute(requestedPath)) {
        throw repoToolFailure('workspace_escape', `ripgrep base must be workspace-relative: ${requestedPath}`);
    }
    const lexical = resolve(guard.root, requestedPath);
    let physical: string;
    try {
        physical = await realpath(lexical);
    } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
            throw repoToolFailure('not_found', `ripgrep base does not exist: ${requestedPath}`);
        }
        throw repoToolFailure('read_failed', errorMessage(error));
    }
    const rel = relative(guard.root, physical);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw repoToolFailure('workspace_escape', `ripgrep base escapes workspace: ${requestedPath}`);
    }
    if (guard.isDeniedAbsolutePath(physical)) {
        throw repoToolFailure('workspace_denied', `ripgrep base is denied by workspace policy: ${requestedPath}`);
    }
    return { absolutePath: physical, relativePath: rel.split(/[\\/]/).join('/') };
}

async function requireReadPermission(
    options: RipgrepToolFactoryOptions,
    toolCallId: string,
    action: string,
    path: string,
): Promise<void> {
    if (options.requestPermission === undefined) {
        return;
    }
    const decision = await requestToolPermission(
        options.requestPermission,
        permissionRequest({
            toolCallId,
            action,
            reason: `${action} within workspace: ${path}`,
            permission: 'read',
            patterns: [path],
            workspaceRoot: options.workspaceRoot,
        }),
    );
    if (decision.status === 'allow') {
        return;
    }
    throw repoToolFailure(
        'read_failed',
        `${decision.status === 'deny' ? 'permission_denied' : 'approval_required'}: ${
            decision.reason ?? `${action} denied`
        }`,
    );
}

function isENOENT(spawnErrorMessage: string): boolean {
    return /spawn failed:/.test(spawnErrorMessage) && /ENOENT/i.test(spawnErrorMessage);
}

function isNodeError(error: unknown, code: string): error is { readonly code: string } {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export const ripgrepTestHooks: Readonly<{
    resetCliCache: () => void;
    forceBackend: (backend: SearchBackend) => void;
}> = Object.freeze({
    resetCliCache: () => resetSearchCliCacheForTests(),
    forceBackend: (backend: SearchBackend) => {
        resetSearchCliCacheForTests();
        if (backend === 'rg' || backend === 'grep') {
            // Skip the other spawn-based tier so the requested one wins.
            const skip = backend === 'rg' ? 'grep' : 'rg';
            reresolveSearchCliSkipping(skip);
            return;
        }
        // node tier — skip both spawn-based tiers.
        reresolveSearchCliSkipping('rg');
        reresolveSearchCliSkipping('grep');
    },
});
