import {
    type BoulderState,
    BoulderStoreError,
    type BoulderWork,
    boulderFilePath,
    readBoulder,
    writeBoulder,
} from './boulder-store.js';
import { type FileHandle, mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const mutationQueues = new Map<string, Promise<void>>();

export async function mutateBoulderWork(
    root: string,
    workId: string,
    mutation: (work: BoulderWork) => BoulderWork,
): Promise<BoulderState> {
    const key = boulderFilePath(root);
    const previous = mutationQueues.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    mutationQueues.set(key, tail);

    await previous.catch(() => undefined);
    try {
        return await withBoulderMutationLock(root, async () => {
            const state = await readBoulder(root);
            if (state === null) {
                throw new BoulderStoreError(
                    `Cannot mutate work ${workId}: boulder.json is missing at ${key}`,
                    'boulder_missing',
                    key,
                );
            }
            const work = state.works[workId];
            if (work === undefined) {
                throw new BoulderStoreError(
                    `Cannot mutate work ${workId}: not present in boulder works`,
                    'boulder_work_missing',
                    key,
                );
            }
            const updated: BoulderState = {
                ...state,
                works: { ...state.works, [workId]: mutation(work) },
            };
            await writeBoulder(root, updated);
            return updated;
        });
    } finally {
        release();
        if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
    }
}

async function withBoulderMutationLock<Result>(root: string, operation: () => Promise<Result>): Promise<Result> {
    const lockPath = `${boulderFilePath(root)}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    let handle: FileHandle;
    try {
        handle = await open(lockPath, 'wx', 0o600);
    } catch (error: unknown) {
        if (isNodeError(error, 'EEXIST')) {
            throw new BoulderStoreError(
                `Cannot mutate boulder state while another process holds ${lockPath}`,
                'boulder_lock_busy',
                lockPath,
                error,
            );
        }
        throw error;
    }
    try {
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        return await operation();
    } finally {
        await handle.close();
        await rm(lockPath, { force: true });
    }
}

function isNodeError(error: unknown, code: string): error is { readonly code: string } {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
