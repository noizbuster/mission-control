import type { LegacySessionSourceKind } from './session-import-sql';
import { createHash } from 'node:crypto';
import { type FileHandle, lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type FoundLegacySource = {
    readonly kind: 'found';
    readonly sourceKind: LegacySessionSourceKind;
    readonly sourcePath: string;
    readonly contents: string;
    readonly checksum: string;
};

export type LegacySourceRead = FoundLegacySource | { readonly kind: 'missing' };

export const MAX_LEGACY_SOURCE_BYTES = 64 * 1024 * 1024;

export async function readLegacySource(
    sourcePath: string,
    sourceKind: LegacySessionSourceKind,
): Promise<LegacySourceRead> {
    let fileHandle: FileHandle | undefined;
    try {
        const pathStats = await lstat(sourcePath);
        if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.size > MAX_LEGACY_SOURCE_BYTES) {
            throw new Error(`Legacy session source exceeds the safe import bound: ${sourcePath}`);
        }
        fileHandle = await open(sourcePath, 'r');
        const openedStats = await fileHandle.stat();
        if (
            !openedStats.isFile() ||
            openedStats.dev !== pathStats.dev ||
            openedStats.ino !== pathStats.ino ||
            openedStats.size > MAX_LEGACY_SOURCE_BYTES
        ) {
            throw new Error(`Legacy session source changed during import: ${sourcePath}`);
        }
        const expectedBytes = openedStats.size;
        const buffer = Buffer.allocUnsafe(Math.min(expectedBytes + 1, MAX_LEGACY_SOURCE_BYTES + 1));
        let totalBytes = 0;
        while (totalBytes < buffer.length) {
            const { bytesRead } = await fileHandle.read(buffer, totalBytes, buffer.length - totalBytes, totalBytes);
            if (bytesRead === 0) break;
            totalBytes += bytesRead;
        }
        if (totalBytes > MAX_LEGACY_SOURCE_BYTES) {
            throw new Error(`Legacy session source exceeds the safe import bound: ${sourcePath}`);
        }
        if (totalBytes !== expectedBytes) {
            throw new Error(`Legacy session source changed during import: ${sourcePath}`);
        }
        const contents = buffer.subarray(0, totalBytes).toString('utf8');
        return { kind: 'found', sourceKind, sourcePath, contents, checksum: checksumFor(contents) };
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return { kind: 'missing' };
        }
        throw error;
    } finally {
        await fileHandle?.close();
    }
}

export async function jsonlSourcePaths(dataDir: string): Promise<readonly string[]> {
    const sessionsDir = join(dataDir, 'sessions');
    const entries = await readDirOrEmpty(sessionsDir);
    return entries
        .filter((entry) => entry.endsWith('.jsonl'))
        .map((entry) => join(sessionsDir, entry))
        .sort();
}

export async function runSourcePaths(omoRoot: string): Promise<readonly string[]> {
    const runsDir = join(omoRoot, 'runs');
    const entries = await readDirOrEmpty(runsDir);
    return entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => join(runsDir, entry))
        .sort();
}

export function checksumFor(contents: string): string {
    return createHash('sha256').update(contents).digest('hex');
}

async function readDirOrEmpty(dir: string): Promise<readonly string[]> {
    try {
        return await readdir(dir);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return [];
        }
        throw error;
    }
}

function isErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
