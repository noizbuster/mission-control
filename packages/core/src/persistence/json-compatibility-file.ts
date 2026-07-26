import { MC_DIR_NAME, mcDirPath, mcFilePath } from './paths';
import { isErrorCode } from '../util/node-error';
import type { Stats } from 'node:fs';
import { type FileHandle, lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const JSON_EXTENSION = '.json';
const MAX_COMPATIBILITY_JSON_BYTES = 8 * 1024 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export type JsonCompatibilityFileErrorCode = 'invalid_id' | 'not_found' | 'unsafe_source' | 'read_failed';

export class JsonCompatibilityFileError extends Error {
    constructor(
        readonly code: JsonCompatibilityFileErrorCode,
        readonly path: string,
        options?: { readonly cause?: unknown },
    ) {
        super(`Compatibility JSON file error: ${code}`, options);
        this.name = 'JsonCompatibilityFileError';
    }
}

export function compatibilityJsonFilePath(root: string, subdirectory: string, recordId: string): string {
    assertSafeRecordId(recordId, root);
    return mcFilePath(root, subdirectory, `${recordId}${JSON_EXTENSION}`);
}

export async function listCompatibilityJsonRecordIds(root: string, subdirectory: string): Promise<readonly string[]> {
    const directory = await safeCompatibilityDirectory(root, subdirectory, true);
    if (directory === undefined) return [];
    try {
        return (await readdir(directory.path))
            .filter((entry) => entry.endsWith(JSON_EXTENSION))
            .map((entry) => entry.slice(0, -JSON_EXTENSION.length));
    } catch (error: unknown) {
        throw new JsonCompatibilityFileError('read_failed', directory.path, { cause: error });
    }
}

export async function readCompatibilityJsonFile(root: string, subdirectory: string, recordId: string): Promise<string> {
    const filePath = compatibilityJsonFilePath(root, subdirectory, recordId);
    const directory = await safeCompatibilityDirectory(root, subdirectory, false);
    let pathStats: Stats;
    try {
        pathStats = await lstat(filePath);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) throw new JsonCompatibilityFileError('not_found', filePath, { cause: error });
        throw new JsonCompatibilityFileError('read_failed', filePath, { cause: error });
    }
    if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.size > MAX_COMPATIBILITY_JSON_BYTES) {
        throw new JsonCompatibilityFileError('unsafe_source', filePath);
    }
    let fileHandle: FileHandle | undefined;
    try {
        fileHandle = await open(filePath, 'r');
        const openedStats = await fileHandle.stat();
        if (
            !openedStats.isFile() ||
            openedStats.dev !== pathStats.dev ||
            openedStats.ino !== pathStats.ino ||
            openedStats.size > MAX_COMPATIBILITY_JSON_BYTES ||
            (await realpath(directory.path)) !== directory.canonicalPath
        ) {
            throw new JsonCompatibilityFileError('unsafe_source', filePath);
        }
        return await readBounded(fileHandle, filePath);
    } catch (error: unknown) {
        if (error instanceof JsonCompatibilityFileError) throw error;
        throw new JsonCompatibilityFileError('read_failed', filePath, { cause: error });
    } finally {
        await fileHandle?.close();
    }
}

type CompatibilityDirectory = {
    readonly path: string;
    readonly canonicalPath: string;
};

function safeCompatibilityDirectory(
    root: string,
    subdirectory: string,
    allowMissing: false,
): Promise<CompatibilityDirectory>;
function safeCompatibilityDirectory(
    root: string,
    subdirectory: string,
    allowMissing: true,
): Promise<CompatibilityDirectory | undefined>;
async function safeCompatibilityDirectory(
    root: string,
    subdirectory: string,
    allowMissing: boolean,
): Promise<CompatibilityDirectory | undefined> {
    const mcDirectory = mcDirPath(root);
    const directory = mcFilePath(root, subdirectory);
    const canonicalRoot = await realpath(root);
    const candidates = [
        { path: mcDirectory, canonicalPath: join(canonicalRoot, MC_DIR_NAME) },
        { path: directory, canonicalPath: join(canonicalRoot, MC_DIR_NAME, subdirectory) },
    ] as const;
    for (const candidate of candidates) {
        try {
            const stats = await lstat(candidate.path);
            if (
                stats.isSymbolicLink() ||
                !stats.isDirectory() ||
                (await realpath(candidate.path)) !== candidate.canonicalPath
            ) {
                throw new JsonCompatibilityFileError('unsafe_source', candidate.path);
            }
        } catch (error: unknown) {
            if (allowMissing && isErrorCode(error, 'ENOENT')) return undefined;
            if (error instanceof JsonCompatibilityFileError) throw error;
            if (isErrorCode(error, 'ENOENT'))
                throw new JsonCompatibilityFileError('not_found', candidate.path, { cause: error });
            throw new JsonCompatibilityFileError('read_failed', candidate.path, { cause: error });
        }
    }
    return candidates[1];
}

async function readBounded(fileHandle: FileHandle, filePath: string): Promise<string> {
    const buffer = Buffer.allocUnsafe(MAX_COMPATIBILITY_JSON_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
        const { bytesRead } = await fileHandle.read(buffer, totalBytes, buffer.length - totalBytes, totalBytes);
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
    }
    if (totalBytes > MAX_COMPATIBILITY_JSON_BYTES) {
        throw new JsonCompatibilityFileError('unsafe_source', filePath);
    }
    return utf8Decoder.decode(buffer.subarray(0, totalBytes));
}

function assertSafeRecordId(recordId: string, root: string): void {
    if (recordId === '' || recordId === '.' || recordId === '..' || /[\\/\0]/u.test(recordId)) {
        throw new JsonCompatibilityFileError('invalid_id', root);
    }
}


