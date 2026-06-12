import {
    type JsonlSessionLockIdentity,
    readJsonlSessionLockIdentity,
    removeJsonlSessionLockPathIfOwned,
} from './jsonl-session-lock-identity.js';
import { type JsonlSessionLockReadResult, lockMetadataFromUnknown } from './jsonl-session-lock-metadata.js';
import { randomUUID } from 'node:crypto';
import { link, open, rm } from 'node:fs/promises';

export type ReadJsonlSessionLockInput = {
    readonly sessionId: string;
    readonly lockPath: string;
};

export async function readExistingJsonlSessionLock(
    input: ReadJsonlSessionLockInput,
): Promise<JsonlSessionLockReadResult> {
    try {
        return await readExistingJsonlSessionLockHandle(input);
    } catch (error: unknown) {
        if (getErrorCode(error) === 'ENOENT') {
            return { kind: 'missing' };
        }
        return { kind: 'invalid', cause: error };
    }
}

export async function removeClaimedJsonlSessionLockPath(
    lockPath: string,
    identity: JsonlSessionLockIdentity,
): Promise<boolean> {
    const claimPath = `${lockPath}.claim-${randomUUID()}`;
    try {
        await link(lockPath, claimPath);
        const claimIdentity = await readClaimIdentity(claimPath);
        if (claimIdentity.dev !== identity.dev || claimIdentity.ino !== identity.ino) {
            return false;
        }
        return removeJsonlSessionLockPathIfOwned(lockPath, identity);
    } finally {
        await rm(claimPath, { force: true });
    }
}

async function readExistingJsonlSessionLockHandle(
    input: ReadJsonlSessionLockInput,
): Promise<JsonlSessionLockReadResult> {
    const lockHandle = await open(input.lockPath, 'r');
    try {
        const lockStats = await lockHandle.stat();
        const identity = { dev: lockStats.dev, ino: lockStats.ino };
        const modifiedAtMs = lockStats.mtimeMs;
        const contents = await lockHandle.readFile('utf8');
        const metadata = lockMetadataFromUnknown(JSON.parse(contents));
        if (metadata?.sessionId === input.sessionId) {
            return { kind: 'metadata', metadata, identity, modifiedAtMs };
        }
        return {
            kind: 'invalid',
            cause: new Error('lock metadata belongs to another session'),
            identity,
            modifiedAtMs,
        };
    } catch (error: unknown) {
        const identity = await readJsonlSessionLockIdentity(lockHandle);
        const stats = await lockHandle.stat();
        return { kind: 'invalid', cause: error, identity, modifiedAtMs: stats.mtimeMs };
    } finally {
        await lockHandle.close();
    }
}

async function readClaimIdentity(claimPath: string): Promise<JsonlSessionLockIdentity> {
    const claimHandle = await open(claimPath, 'r');
    try {
        return readJsonlSessionLockIdentity(claimHandle);
    } finally {
        await claimHandle.close();
    }
}

function getErrorCode(error: unknown): string | undefined {
    if (!(error instanceof Error) || !('code' in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
