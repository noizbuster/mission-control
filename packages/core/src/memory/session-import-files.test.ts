import { afterEach, describe, expect, it } from 'vitest';
import { MAX_LEGACY_SOURCE_BYTES, readLegacySource } from './session-import-files';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('readLegacySource', () => {
    it('rejects an oversized sparse source before reading it into memory', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mctrl-legacy-source-bound-'));
        directories.push(directory);
        const sourcePath = join(directory, 'oversized.jsonl');
        await writeFile(sourcePath, '');
        await truncate(sourcePath, MAX_LEGACY_SOURCE_BYTES + 1);

        await expect(readLegacySource(sourcePath, 'jsonl')).rejects.toThrow('exceeds the safe import bound');
    });
});
