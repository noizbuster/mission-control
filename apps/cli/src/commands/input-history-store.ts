import { TuiStores } from '@mission-control/core';
import type { TuiPromptHistoryEntry } from '@mission-control/protocol';

/** Process-local store so concurrent appends share one writeChain. */
let sharedStore: InstanceType<typeof TuiStores.TuiPromptHistoryStore> | undefined;

export function getSharedHistoryStore(): InstanceType<typeof TuiStores.TuiPromptHistoryStore> {
    if (sharedStore === undefined) {
        sharedStore = new TuiStores.TuiPromptHistoryStore();
    }
    return sharedStore;
}

/** Test-only: drop the cached store (e.g. after temp dataDir changes). */
export function resetInputHistoryStoreForTests(): void {
    sharedStore = undefined;
}

export async function loadInputHistoryEntries(): Promise<readonly TuiPromptHistoryEntry[]> {
    return getSharedHistoryStore().listEntries();
}

export async function appendInputHistoryEntry(value: string): Promise<void> {
    await getSharedHistoryStore().appendText(value);
}
