import type { LegacySessionSourceKind } from './session-import-sql.js';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type FoundLegacySource = {
    readonly kind: 'found';
    readonly sourceKind: LegacySessionSourceKind;
    readonly sourcePath: string;
    readonly contents: string;
    readonly checksum: string;
};

export type LegacySourceRead = FoundLegacySource | { readonly kind: 'missing' };

export async function readLegacySource(
    sourcePath: string,
    sourceKind: LegacySessionSourceKind,
): Promise<LegacySourceRead> {
    try {
        const contents = await readFile(sourcePath, 'utf8');
        return { kind: 'found', sourceKind, sourcePath, contents, checksum: checksumFor(contents) };
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return { kind: 'missing' };
        }
        throw error;
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
