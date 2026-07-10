import { TuiStores } from '@mission-control/core';
import type { TuiPromptHistoryEntry } from '@mission-control/protocol';

export async function loadInputHistoryEntries(): Promise<readonly TuiPromptHistoryEntry[]> {
    return new TuiStores.TuiPromptHistoryStore().listEntries();
}

export async function appendInputHistoryEntry(value: string): Promise<void> {
    await new TuiStores.TuiPromptHistoryStore().appendText(value);
}
