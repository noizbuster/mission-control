import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const OMO_DIR_NAME = '.omo';

export const OMO_SUBDIR_PLANS = 'plans';
export const OMO_SUBDIR_NOTEPADS = 'notepads';
export const OMO_SUBDIR_MISSIONS = 'missions';
export const OMO_SUBDIR_RUNS = 'runs';

export const DEFAULT_OMO_SUBDIRS: readonly string[] = [
    OMO_SUBDIR_PLANS,
    OMO_SUBDIR_NOTEPADS,
    OMO_SUBDIR_MISSIONS,
    OMO_SUBDIR_RUNS,
];

export class OmoPersistenceError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly path?: string,
        options?: { readonly cause?: unknown },
    ) {
        super(message, options);
        this.name = 'OmoPersistenceError';
    }
}

export function omoDirPath(root: string): string {
    return join(root, OMO_DIR_NAME);
}

export function omoFilePath(root: string, ...segments: readonly string[]): string {
    return join(root, OMO_DIR_NAME, ...segments);
}

/**
 * Walk up from `startPath` until a `.omo/` directory is found.
 * Returns the project root that contains `.omo/` (not the `.omo/` path itself).
 * Throws `OmoPersistenceError` ({ code: 'omo_root_not_found' }) when no ancestor contains `.omo/`.
 */
export async function resolveOmoRoot(startPath: string): Promise<string> {
    const absoluteStart = isAbsolute(startPath) ? startPath : resolve(startPath);
    let current = absoluteStart;
    // Guard against infinite loops on degenerate paths.
    let previous = '';
    while (current !== previous) {
        const candidate = omoDirPath(current);
        if (await isDirectoryPresent(candidate)) {
            return current;
        }
        previous = current;
        current = dirname(current);
    }
    throw new OmoPersistenceError(
        `Could not resolve an '.omo/' directory starting from ${absoluteStart}`,
        'omo_root_not_found',
        absoluteStart,
    );
}

/**
 * Idempotently create the standard `.omo/` subdirectories under `root`.
 * Pass an explicit `subdirs` list to create a subset; omit it for the default layout.
 */
export async function ensureOmoDirs(
    root: string,
    subdirs: readonly string[] = DEFAULT_OMO_SUBDIRS,
): Promise<readonly string[]> {
    const created: string[] = [];
    for (const subdir of subdirs) {
        assertSafeSubdirName(subdir);
        const target = omoFilePath(root, subdir);
        await mkdir(target, { recursive: true });
        created.push(target);
    }
    return created;
}

/**
 * Best-effort check whether `targetPath` is covered by a `.gitignore` pattern.
 * Reads `.gitignore` files from the target's directory up through ancestors and
 * applies a pragmatic subset of gitignore semantics: trailing-slash directory
 * patterns, basename name patterns, and simple `*` globs. Negation (`!`) patterns
 * un-ignore. This is intentionally not a full git implementation; it answers the
 * question "is this path ignored by a simple .gitignore entry?".
 */
export async function isGitignored(targetPath: string): Promise<boolean> {
    const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(targetPath);
    const targetDir = absoluteTarget;
    const patterns = await collectGitignorePatterns(targetDir);

    let ignored = false;
    for (const { pattern, baseDir } of patterns) {
        if (matchesGitignorePattern(pattern, absoluteTarget, baseDir)) {
            ignored = !pattern.negated;
        }
    }
    return ignored;
}

async function isDirectoryPresent(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function assertSafeSubdirName(name: string): void {
    if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new OmoPersistenceError(
            `Refusing to create .omo/ subdir with unsafe name ${JSON.stringify(name)}`,
            'omo_unsafe_subdir',
            name,
        );
    }
}

type GitignorePattern = {
    readonly raw: string;
    readonly negated: boolean;
    readonly body: string;
    readonly directoryOnly: boolean;
    readonly anchored: boolean;
};

type ResolvedPattern = {
    readonly pattern: GitignorePattern;
    readonly baseDir: string;
};

async function collectGitignorePatterns(targetPath: string): Promise<readonly ResolvedPattern[]> {
    const resolved: ResolvedPattern[] = [];
    let current = targetPath;
    let previous = '';
    while (current !== previous) {
        const ignoreFile = join(current, '.gitignore');
        const contents = await readOptionalFile(ignoreFile);
        if (contents !== undefined) {
            for (const raw of contents.split(/\r?\n/)) {
                const pattern = parseGitignoreLine(raw);
                if (pattern !== undefined) {
                    resolved.push({ pattern, baseDir: current });
                }
            }
        }
        previous = current;
        current = dirname(current);
    }
    return resolved;
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return undefined;
        }
        throw error;
    }
}

function parseGitignoreLine(line: string): GitignorePattern | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
        return undefined;
    }
    let negated = false;
    let body = trimmed;
    if (body.startsWith('!')) {
        negated = true;
        body = body.slice(1);
    }
    // Drop trailing spaces not escaped with backslash (git semantics).
    body = body.replace(/(?<!\\)\s+$/u, '');
    if (body.length === 0) {
        return undefined;
    }
    const directoryOnly = body.endsWith('/');
    if (directoryOnly) {
        body = body.slice(0, -1);
    }
    const anchored = body.includes('/');
    return { raw: trimmed, negated, body, directoryOnly, anchored };
}

function matchesGitignorePattern(pattern: GitignorePattern, targetPath: string, baseDir: string): boolean {
    const relativePath = relative(baseDir, targetPath);
    if (relativePath === '' || relativePath.startsWith('..')) {
        return false;
    }
    const segments = relativePath.split(sep);
    const regex = globToRegex(pattern.body, pattern.anchored);
    if (pattern.anchored) {
        const candidate = pattern.directoryOnly ? firstSegment(relativePath) : relativePath;
        return regex.test(candidate);
    }
    // Unanchored patterns match any path segment (basename semantics).
    for (const segment of segments) {
        if (regex.test(segment)) {
            return true;
        }
    }
    return false;
}

function firstSegment(path: string): string {
    const segments = path.split(sep);
    return segments[0] ?? path;
}

function globToRegex(glob: string, anchored: boolean): RegExp {
    const source = glob
        .split('')
        .map((ch) => {
            if (ch === '*') return '[^/]*';
            if (ch === '?') return '[^/]';
            return escapeRegExp(ch);
        })
        .join('');
    const body = anchored ? `^${source}` : `^${source}$`;
    return new RegExp(body);
}

function escapeRegExp(ch: string): string {
    return /[.*+?^${}()|[\]\\]/u.test(ch) ? `\\${ch}` : ch;
}

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
