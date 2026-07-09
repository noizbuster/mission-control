import { TuiStores } from '@mission-control/core';

export async function loadInputHistoryEntries(): Promise<readonly string[]> {
    return new TuiStores.TuiPromptHistoryStore().listTexts();
}

export async function appendInputHistoryEntry(value: string): Promise<void> {
    await new TuiStores.TuiPromptHistoryStore().appendText(value);
}
