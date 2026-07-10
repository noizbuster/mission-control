import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendInputHistoryEntry, loadInputHistoryEntries } from './input-history-store.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('input history store bridge', () => {
    let dataDir: string | undefined;

    afterEach(async () => {
        vi.unstubAllEnvs();
        if (dataDir !== undefined) {
            await rm(dataDir, { recursive: true, force: true });
            dataDir = undefined;
        }
    });

    it('persists submitted prompts through the typed core prompt history store', async () => {
        dataDir = await createDataDir();

        await appendInputHistoryEntry('first prompt');
        await appendInputHistoryEntry('first prompt');

        const loaded = await loadInputHistoryEntries();
        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.text).toBe('first prompt');
        expect(loaded[0]?.timestamp).toBeGreaterThan(0);
        const raw: unknown = JSON.parse(await readFile(join(dataDir, 'input-history.json'), 'utf8'));
        expect(raw).toMatchObject({ entries: [{ text: 'first prompt' }] });
    });

    it('keeps existing plain-string history readable while appending through the typed store', async () => {
        dataDir = await createDataDir();
        await writeFile(
            join(dataDir, 'input-history.json'),
            JSON.stringify({ entries: ['legacy prompt', ''] }),
            'utf8',
        );

        const legacy = await loadInputHistoryEntries();
        expect(legacy.map((entry) => entry.text)).toEqual(['legacy prompt']);
        expect(legacy[0]?.timestamp).toBe(0);
        await appendInputHistoryEntry('new prompt');

        const after = await loadInputHistoryEntries();
        expect(after.map((entry) => entry.text)).toEqual(['legacy prompt', 'new prompt']);
    });

    async function createDataDir(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'mctrl-input-history-'));
        vi.stubEnv('MCTRL_DATA_DIR', dir);
        return dir;
    }
});
