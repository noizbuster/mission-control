import { resolveMissionControlDataDir } from '@mission-control/core';
import { type AbgOverlayPrefs, AbgOverlayPrefsSchema } from '@mission-control/protocol';
import { atomicTextWrite } from './atomic-text-write';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const OVERLAY_PREFS_FILENAME = 'abg-overlay-prefs.json';

const DEFAULT_PREFS: AbgOverlayPrefs = {
    activeTabIndex: 0,
    scrollOffset: 0,
    liveOutput: true,
    showThinking: false,
    toolOutputExpanded: true,
};

/** Process-local per-path chains so concurrent saveAbgOverlayPrefs cannot clobber. */
const prefsWriteChains = new Map<string, Promise<unknown>>();

function enqueuePrefsWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = prefsWriteChains.get(path) ?? Promise.resolve();
    const run = previous.then(task, task);
    prefsWriteChains.set(
        path,
        run.then(
            () => undefined,
            () => undefined,
        ),
    );
    return run;
}

function prefsFilePath(): string {
    const dataDir = resolveMissionControlDataDir();
    return join(dataDir, OVERLAY_PREFS_FILENAME);
}

export async function loadAbgOverlayPrefs(): Promise<AbgOverlayPrefs> {
    const filePath = prefsFilePath();
    try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        const result = AbgOverlayPrefsSchema.safeParse(parsed);
        if (result.success) {
            return result.data;
        }
        return { ...DEFAULT_PREFS };
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

export async function saveAbgOverlayPrefs(prefs: AbgOverlayPrefs): Promise<void> {
    const filePath = prefsFilePath();
    const validated = AbgOverlayPrefsSchema.parse(prefs);
    await enqueuePrefsWrite(filePath, async () => {
        await atomicTextWrite(filePath, `${JSON.stringify(validated, null, 2)}\n`);
    });
}

export const DEFAULT_ABG_OVERLAY_PREFS: AbgOverlayPrefs = DEFAULT_PREFS;
