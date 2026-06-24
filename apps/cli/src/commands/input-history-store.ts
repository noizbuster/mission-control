import { resolveMissionControlDataDir } from '@mission-control/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const INPUT_HISTORY_FILENAME = 'input-history.json';
const MAX_ENTRIES = 1000;

type InputHistoryFile = {
    readonly entries: readonly string[];
};

export async function loadInputHistoryEntries(): Promise<readonly string[]> {
    const dataDir = resolveMissionControlDataDir();
    const filePath = join(dataDir, INPUT_HISTORY_FILENAME);
    try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'entries' in parsed &&
            Array.isArray((parsed as InputHistoryFile).entries)
        ) {
            const entries = (parsed as InputHistoryFile).entries.filter(
                (entry): entry is string => typeof entry === 'string' && entry.length > 0,
            );
            return entries.slice(-MAX_ENTRIES);
        }
        return [];
    } catch {
        return [];
    }
}

export async function appendInputHistoryEntry(value: string): Promise<void> {
    if (value.length === 0) {
        return;
    }
    const dataDir = resolveMissionControlDataDir();
    const filePath = join(dataDir, INPUT_HISTORY_FILENAME);
    const existing = await loadInputHistoryEntries();
    if (existing.length > 0 && existing[existing.length - 1] === value) {
        return;
    }
    const entries = [...existing, value].slice(-MAX_ENTRIES);
    const payload: InputHistoryFile = { entries };
    await mkdir(dataDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}
