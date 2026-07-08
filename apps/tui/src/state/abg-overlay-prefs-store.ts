import { resolveMissionControlDataDir } from '@mission-control/core';
import { type AbgOverlayPrefs, AbgOverlayPrefsSchema } from '@mission-control/protocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OVERLAY_PREFS_FILENAME = 'abg-overlay-prefs.json';

const DEFAULT_PREFS: AbgOverlayPrefs = {
    activeTabIndex: 0,
    scrollOffset: 0,
    liveOutput: true,
    showThinking: false,
    toolOutputExpanded: false,
};

export async function loadAbgOverlayPrefs(): Promise<AbgOverlayPrefs> {
    const dataDir = resolveMissionControlDataDir();
    const filePath = join(dataDir, OVERLAY_PREFS_FILENAME);
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
    const dataDir = resolveMissionControlDataDir();
    const filePath = join(dataDir, OVERLAY_PREFS_FILENAME);
    await mkdir(dataDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(prefs, null, 2), 'utf-8');
}

export const DEFAULT_ABG_OVERLAY_PREFS: AbgOverlayPrefs = DEFAULT_PREFS;
