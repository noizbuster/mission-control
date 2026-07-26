import { lstat, realpath } from 'node:fs/promises';
import { isMissingPathError } from '../util/node-error';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const localDbConfigErrorCodes = [
    'remote_url',
    'invalid_file_host',
    'invalid_file_port',
    'invalid_file_credentials',
    'invalid_file_query',
    'invalid_file_fragment',
    'unresolvable_file_path',
] as const;
export type LocalDbConfigErrorCode = (typeof localDbConfigErrorCodes)[number];

export class LocalDbConfigError extends Error {
    readonly code: LocalDbConfigErrorCode;
    readonly scheme: string;

    constructor(code: LocalDbConfigErrorCode, url: string) {
        const scheme = rejectedUrlScheme(url);
        const message =
            code === 'remote_url'
                ? `Local libSQL databases only accept :memory: or file: URLs; received ${scheme} URL`
                : `Invalid local file URL (${code})`;
        super(message);
        this.name = 'LocalDbConfigError';
        this.code = code;
        this.scheme = scheme;
    }
}

export type LocalLibsqlWriteKey = string | symbol;

export type LocalLibsqlIdentity = {
    readonly url: string;
    readonly writeKey: LocalLibsqlWriteKey;
};

export type ResolveLocalLibsqlIdentityOptions = {
    readonly url: string;
    readonly cwd?: string;
};

export async function resolveLocalLibsqlIdentity(
    options: ResolveLocalLibsqlIdentityOptions,
): Promise<LocalLibsqlIdentity> {
    if (options.url === ':memory:') {
        return { url: ':memory:', writeKey: Symbol('local-libsql-memory') };
    }
    if (!options.url.startsWith('file:')) {
        throw new LocalDbConfigError('remote_url', options.url);
    }

    const unresolvedPath = filePathFromUrl(options.url);
    try {
        const lexicalPath = resolve(options.cwd ?? process.cwd(), unresolvedPath);
        const canonicalPath = await resolveThroughExistingAncestor(lexicalPath);
        const canonicalUrl = pathToFileURL(canonicalPath).href;
        return { url: canonicalUrl, writeKey: canonicalUrl };
    } catch (error: unknown) {
        if (error instanceof LocalDbConfigError) throw error;
        throw new LocalDbConfigError('unresolvable_file_path', options.url);
    }
}

function filePathFromUrl(url: string): string {
    const payload = url.slice('file:'.length);
    const queryIndex = payload.indexOf('?');
    const fragmentIndex = payload.indexOf('#');
    const pathEnd = firstComponentIndex(payload.length, queryIndex, fragmentIndex);
    const location = payload.slice(0, pathEnd);
    const hasAuthority = location.startsWith('//');

    if (hasAuthority) validateAuthority(location.slice(2).split('/', 1)[0] ?? '', url);
    if (queryIndex >= 0) throw new LocalDbConfigError('invalid_file_query', url);
    if (fragmentIndex >= 0) throw new LocalDbConfigError('invalid_file_fragment', url);
    if (location.length === 0 || location === '//') {
        throw new LocalDbConfigError('unresolvable_file_path', url);
    }

    try {
        if (hasAuthority || location.startsWith('/')) return fileURLToPath(url);
        if (/%(?:2f|5c)/iu.test(location)) throw new URIError('encoded path separator');
        const decoded = decodeURIComponent(location);
        if (decoded.length === 0 || decoded.includes('\0')) throw new URIError('invalid file path');
        return decoded;
    } catch {
        throw new LocalDbConfigError('unresolvable_file_path', url);
    }
}

function validateAuthority(authority: string, url: string): void {
    if (authority.includes('@')) throw new LocalDbConfigError('invalid_file_credentials', url);
    if (authority.includes(':')) throw new LocalDbConfigError('invalid_file_port', url);
    if (authority.length > 0 && authority.toLowerCase() !== 'localhost') {
        throw new LocalDbConfigError('invalid_file_host', url);
    }
}

async function resolveThroughExistingAncestor(path: string): Promise<string> {
    let candidate = path;
    const missingSegments: string[] = [];

    while (true) {
        try {
            return resolve(await realpath(candidate), ...missingSegments);
        } catch (error: unknown) {
            if (!isMissingPathError(error)) throw error;
            if (await pathEntryExists(candidate)) throw error;
            const parent = dirname(candidate);
            if (parent === candidate) throw error;
            missingSegments.unshift(basename(candidate));
            candidate = parent;
        }
    }
}

async function pathEntryExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error: unknown) {
        if (isMissingPathError(error)) return false;
        throw error;
    }
}

function firstComponentIndex(fallback: number, ...indices: readonly number[]): number {
    return indices.reduce((current, index) => (index >= 0 && index < current ? index : current), fallback);
}

function rejectedUrlScheme(url: string): string {
    const schemeSeparator = url.indexOf(':');
    return schemeSeparator <= 0 ? 'unsupported' : url.slice(0, schemeSeparator);
}


