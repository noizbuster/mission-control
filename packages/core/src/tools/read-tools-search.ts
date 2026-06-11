import { z } from 'zod';
import { repoToolFailure } from './read-tools-errors.js';
import { isBinarySample, type WorkspaceGuard, type WorkspacePath } from './read-tools-paths.js';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type RepoSearchInput = {
    readonly pattern: string;
    readonly path?: string;
    readonly include?: string;
};

export type RepoSearchMatch = {
    readonly path: string;
    readonly line: number;
    readonly text: string;
    readonly textTruncated: boolean;
};

export type RepoSearchOptions = {
    readonly maxMatches: number;
    readonly maxLineChars: number;
};

export type RepoSearchResult = {
    readonly matches: readonly RepoSearchMatch[];
    readonly totalMatches: number;
};

const rgMatchLineSchema = z.object({
    type: z.string().optional(),
    data: z
        .object({
            path: z.object({ text: z.string().optional() }).optional(),
            line_number: z.number().optional(),
            lines: z.object({ text: z.string().optional() }).optional(),
        })
        .optional(),
});

export async function searchRepoText(
    guard: WorkspaceGuard,
    input: RepoSearchInput,
    options: RepoSearchOptions,
): Promise<RepoSearchResult> {
    const target = await guard.resolveExisting(input.path ?? '.');
    const rgResult = await searchWithRipgrep(guard, target, input, options);
    if (rgResult !== undefined) {
        return rgResult;
    }
    return searchWithNode(guard, target, input, options);
}

async function searchWithRipgrep(
    guard: WorkspaceGuard,
    target: WorkspacePath,
    input: RepoSearchInput,
    options: RepoSearchOptions,
): Promise<RepoSearchResult | undefined> {
    if (guard.hasAllowedDenylistedPaths) {
        return undefined;
    }
    const args = ['--json', '--line-number', '--color=never', '--hidden', '--no-messages'];
    for (const glob of guard.denylistRipgrepGlobs) {
        args.push('--glob', glob);
    }
    if (input.include !== undefined) {
        args.push('--glob', input.include);
    }
    args.push('--', input.pattern, target.absolutePath);

    const processResult = await runRipgrep(args);
    if (processResult === undefined) {
        return undefined;
    }
    if (processResult.code !== 0 && processResult.code !== 1) {
        throw repoToolFailure('search_failed', processResult.stderr.trim() || `rg exited with ${processResult.code}`);
    }
    const rows = processResult.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .flatMap((line) => parseRgMatch(guard, line, options.maxLineChars))
        .sort(compareMatches);
    return {
        matches: rows.slice(0, options.maxMatches),
        totalMatches: rows.length,
    };
}

function runRipgrep(
    args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string } | undefined> {
    return new Promise((resolvePromise) => {
        const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', () => resolvePromise(undefined));
        child.on('close', (code) =>
            resolvePromise({
                code: code ?? 1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            }),
        );
    });
}

function parseRgMatch(guard: WorkspaceGuard, line: string, maxLineChars: number): readonly RepoSearchMatch[] {
    let decoded: unknown;
    try {
        decoded = JSON.parse(line);
    } catch (error) {
        if (error instanceof SyntaxError) {
            return [];
        }
        throw error;
    }
    const parsed = rgMatchLineSchema.safeParse(decoded);
    if (!parsed.success) {
        return [];
    }
    if (parsed.data.type !== 'match') {
        return [];
    }
    const path = parsed.data.data?.path?.text;
    const lineNumber = parsed.data.data?.line_number;
    const text = parsed.data.data?.lines?.text;
    if (path === undefined || lineNumber === undefined || text === undefined) {
        return [];
    }
    if (guard.isDeniedAbsolutePath(path)) {
        return [];
    }
    return [formatMatch(guard.relativeFromAbsolute(path), lineNumber, text.replace(/\n$/, ''), maxLineChars)];
}

async function searchWithNode(
    guard: WorkspaceGuard,
    target: WorkspacePath,
    input: RepoSearchInput,
    options: RepoSearchOptions,
): Promise<RepoSearchResult> {
    const files = target.stats.isDirectory() ? await collectFiles(guard, target.absolutePath) : [target.absolutePath];
    const matches: RepoSearchMatch[] = [];
    let totalMatches = 0;
    for (const file of files) {
        if (input.include !== undefined && !file.endsWith(input.include.replace(/^\*/, ''))) {
            continue;
        }
        const bytes = await readFile(file);
        if (isBinarySample(bytes.subarray(0, 4096))) {
            continue;
        }
        const lines = bytes.toString('utf8').split(/\r?\n/);
        for (const [index, text] of lines.entries()) {
            if (!text.includes(input.pattern)) {
                continue;
            }
            totalMatches += 1;
            if (matches.length < options.maxMatches) {
                matches.push(formatMatch(guard.relativeFromAbsolute(file), index + 1, text, options.maxLineChars));
            }
        }
    }
    return { matches, totalMatches };
}

async function collectFiles(guard: WorkspaceGuard, root: string): Promise<readonly string[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const absolutePath = join(root, entry.name);
        if (!guard.shouldTraverseAbsolutePath(absolutePath)) {
            continue;
        }
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(guard, absolutePath)));
            continue;
        }
        if (entry.isFile()) {
            files.push(absolutePath);
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

function formatMatch(path: string, line: number, text: string, maxLineChars: number): RepoSearchMatch {
    if (text.length <= maxLineChars) {
        return { path, line, text, textTruncated: false };
    }
    const marker = '...';
    return {
        path,
        line,
        text: `${text.slice(0, Math.max(0, maxLineChars - marker.length))}${marker}`,
        textTruncated: true,
    };
}

function compareMatches(left: RepoSearchMatch, right: RepoSearchMatch): number {
    const pathOrder = left.path.localeCompare(right.path);
    if (pathOrder !== 0) {
        return pathOrder;
    }
    if (left.line !== right.line) {
        return left.line - right.line;
    }
    return left.text.localeCompare(right.text);
}
