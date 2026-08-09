import {
    type BoulderState,
    BoulderStoreError,
    type BoulderWork,
    boulderFilePath,
    enqueueBoulderWrite,
    readBoulder,
    writeBoulderUnchained,
} from './boulder-store';
import { isNodeError } from '../util/node-error';
import { type FileHandle, mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function mutateBoulderWork(
    root: string,
    workId: string,
    mutation: (work: BoulderWork) => BoulderWork,
): Promise<BoulderState> {
    // Share the process-local root chain with updateBoulderWork so mixed callers
    // cannot last-write-win; keep the cross-process .lock around the RMW body.
    return enqueueBoulderWrite(root, async () =>
        withBoulderMutationLock(root, async () => {
            const key = boulderFilePath(root);
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
            await writeBoulderUnchained(root, updated);
            return updated;
        }),
    );
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
