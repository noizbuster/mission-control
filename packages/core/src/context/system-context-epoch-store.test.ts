import { afterEach, describe, expect, it } from 'vitest';
import { localSessionDbPath } from '../memory/local-session-store-paths.js';
import { SqlContextEpochStore } from './system-context-epoch-store.js';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-context-epoch-store-'));
    tempRoots.push(root);
    return root;
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqlContextEpochStore', () => {
    it('persists context epoch rows and reads them after reopen', async () => {
        const root = await makeTempRoot();
        const first = await SqlContextEpochStore.open(root);
        await first.recordEpoch({
            sessionId: 'session_context',
            epoch: 0,
            sourceId: 'test/source',
            baselineText: 'Baseline source text',
        });
        await first.recordEpoch({
            sessionId: 'session_context',
            epoch: 1,
            sourceId: 'test/source',
            updateText: 'Updated source text',
        });
        first.close();

        const reopened = await SqlContextEpochStore.open(root);
        const rows = await reopened.listEpochs('session_context');
        reopened.close();

        expect(rows.map((row) => [row.epoch, row.sourceId, row.baselineText, row.updateText])).toEqual([
            [0, 'test/source', 'Baseline source text', undefined],
            [1, 'test/source', undefined, 'Updated source text'],
        ]);
        expect(existsSync(localSessionDbPath(root))).toBe(true);
        expect(existsSync(join(root, '.omo', 'mission-control.db'))).toBe(false);
    });
});
