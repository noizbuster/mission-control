import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ABG_OVERLAY_PREFS, loadAbgOverlayPrefs, saveAbgOverlayPrefs } from './abg-overlay-prefs-store.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TEMP_DATA_DIR = '/tmp/mctrl-abg-overlay-prefs-test';

async function resetTempDir(): Promise<void> {
    await rm(TEMP_DATA_DIR, { recursive: true, force: true });
}

describe('abg-overlay-prefs-store', () => {
    beforeEach(async () => {
        await resetTempDir();
        process.env['MCTRL_DATA_DIR'] = TEMP_DATA_DIR;
    });

    afterEach(async () => {
        delete process.env['MCTRL_DATA_DIR'];
        await resetTempDir();
    });

    it('returns defaults when prefs file missing', async () => {
        const prefs = await loadAbgOverlayPrefs();
        expect(prefs).toEqual(DEFAULT_ABG_OVERLAY_PREFS);
        expect(prefs.activeTabIndex).toBe(0);
        expect(prefs.liveOutput).toBe(true);
    });

    it('returns defaults when prefs file malformed', async () => {
        await mkdir(TEMP_DATA_DIR, { recursive: true });
        await writeFile(join(TEMP_DATA_DIR, 'abg-overlay-prefs.json'), '{ not json');
        const prefs = await loadAbgOverlayPrefs();
        expect(prefs).toEqual(DEFAULT_ABG_OVERLAY_PREFS);
    });

    it('round-trips prefs through save and load', async () => {
        const custom = {
            activeTabIndex: 5,
            scrollOffset: 42,
            liveOutput: false,
            showThinking: true,
            toolOutputExpanded: false,
        };
        await saveAbgOverlayPrefs(custom);
        const loaded = await loadAbgOverlayPrefs();
        expect(loaded).toEqual(custom);
    });

    it('writes a JSON file to the data dir', async () => {
        await saveAbgOverlayPrefs(DEFAULT_ABG_OVERLAY_PREFS);
        const raw = await readFile(join(TEMP_DATA_DIR, 'abg-overlay-prefs.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        expect(parsed.activeTabIndex).toBe(0);
        expect(parsed.liveOutput).toBe(true);
    });

    it('coerces partial/invalid saved prefs back to defaults via safeParse', async () => {
        await mkdir(TEMP_DATA_DIR, { recursive: true });
        await writeFile(
            join(TEMP_DATA_DIR, 'abg-overlay-prefs.json'),
            JSON.stringify({ activeTabIndex: 'not-a-number' }),
        );
        const prefs = await loadAbgOverlayPrefs();
        expect(prefs).toEqual(DEFAULT_ABG_OVERLAY_PREFS);
    });
});
