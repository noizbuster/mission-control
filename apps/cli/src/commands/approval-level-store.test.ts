import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPersistedApprovalLevel, savePersistedApprovalLevel } from './approval-level-store.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TEMP_DATA_DIR = '/tmp/mctrl-approval-level-store-test';

async function resetTempDir(): Promise<void> {
    await rm(TEMP_DATA_DIR, { recursive: true, force: true });
}

describe('approval-level-store', () => {
    beforeEach(async () => {
        await resetTempDir();
        process.env['MCTRL_DATA_DIR'] = TEMP_DATA_DIR;
    });

    afterEach(async () => {
        delete process.env['MCTRL_DATA_DIR'];
        await resetTempDir();
    });

    it('returns undefined when level file missing', async () => {
        const level = await loadPersistedApprovalLevel();
        expect(level).toBeUndefined();
    });

    it('returns undefined when level file malformed JSON', async () => {
        await mkdir(TEMP_DATA_DIR, { recursive: true });
        await writeFile(join(TEMP_DATA_DIR, 'approval-level.json'), '{ not json');
        const level = await loadPersistedApprovalLevel();
        expect(level).toBeUndefined();
    });

    it('returns undefined when stored level is not a known ApprovalLevel', async () => {
        await mkdir(TEMP_DATA_DIR, { recursive: true });
        await writeFile(join(TEMP_DATA_DIR, 'approval-level.json'), JSON.stringify({ level: 'not-a-real-level' }));
        const level = await loadPersistedApprovalLevel();
        expect(level).toBeUndefined();
    });

    it('returns undefined when payload shape is wrong', async () => {
        await mkdir(TEMP_DATA_DIR, { recursive: true });
        await writeFile(join(TEMP_DATA_DIR, 'approval-level.json'), JSON.stringify({ approval: 'safe' }));
        const level = await loadPersistedApprovalLevel();
        expect(level).toBeUndefined();
    });

    it('round-trips a known level through save and load', async () => {
        await savePersistedApprovalLevel('aggressive');
        const loaded = await loadPersistedApprovalLevel();
        expect(loaded).toBe('aggressive');
    });

    it('round-trips the yolo level', async () => {
        await savePersistedApprovalLevel('yolo');
        const loaded = await loadPersistedApprovalLevel();
        expect(loaded).toBe('yolo');
    });

    it('overwrites the previously saved level', async () => {
        await savePersistedApprovalLevel('verbose');
        await savePersistedApprovalLevel('reckless');
        const loaded = await loadPersistedApprovalLevel();
        expect(loaded).toBe('reckless');
    });

    it('writes a JSON file to the data dir with level field', async () => {
        await savePersistedApprovalLevel('safe');
        const raw = await readFile(join(TEMP_DATA_DIR, 'approval-level.json'), 'utf-8');
        const parsed = JSON.parse(raw) as { level: string };
        expect(parsed.level).toBe('safe');
    });
});
