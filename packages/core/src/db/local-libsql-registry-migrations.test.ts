import { afterEach, describe, expect, it } from 'vitest';
import { openLocalLibsqlDb } from './local-libsql-db';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local libSQL registry setup identity', () => {
    it('applies explicit migrations requested by a later shared lease', async () => {
        // Given: one default lease already holds the canonical file client.
        const directory = await mkdtemp(join(tmpdir(), 'mctrl-local-registry-migration-'));
        tempDirectories.push(directory);
        const url = `file:${join(directory, 'shared.db')}`;
        const first = await openLocalLibsqlDb({ url });

        // When: a concurrent lease requests an explicit migration for the same file.
        const migrated = await openLocalLibsqlDb({
            url,
            migrations: [{ id: '0001_shared_widget', sql: 'CREATE TABLE shared_widgets (id TEXT PRIMARY KEY)' }],
        });
        const table = await first.client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shared_widgets'",
        );
        migrated.close();
        first.close();

        // Then: sharing the physical client did not skip the later lease's setup.
        expect(table.rows).toEqual([{ name: 'shared_widgets' }]);
    });
});
