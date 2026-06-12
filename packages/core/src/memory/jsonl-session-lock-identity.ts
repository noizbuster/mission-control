import type { Stats } from 'node:fs';
import { type FileHandle, rm, stat } from 'node:fs/promises';

export type JsonlSessionLockIdentity = Pick<Stats, 'dev' | 'ino'>;

export async function readJsonlSessionLockIdentity(lockHandle: FileHandle): Promise<JsonlSessionLockIdentity> {
    const lockStats = await lockHandle.stat();
    return { dev: lockStats.dev, ino: lockStats.ino };
}

export async function jsonlSessionLockPathMatches(
    lockPath: string,
    lockIdentity: JsonlSessionLockIdentity,
): Promise<boolean> {
    try {
        const pathStats = await stat(lockPath);
        return lockIdentity.dev === pathStats.dev && lockIdentity.ino === pathStats.ino;
    } catch (error: unknown) {
        if (getErrorCode(error) === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

export async function removeJsonlSessionLockPathIfOwned(
    lockPath: string,
    lockIdentity: JsonlSessionLockIdentity,
): Promise<boolean> {
    if (await jsonlSessionLockPathMatches(lockPath, lockIdentity)) {
        await rm(lockPath, { force: true });
        return true;
    }
    return false;
}

function getErrorCode(error: unknown): string | undefined {
    if (!(error instanceof Error) || !('code' in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
