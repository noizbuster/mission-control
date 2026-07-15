import { afterEach, describe, expect, it } from 'vitest';
import { runSqliteSessionWriteTransaction } from '../memory/sqlite-session-event-store-transaction';
import { LocalDbConfigError, localDbConfigErrorCodes, openLocalLibsqlDb } from './local-libsql-db';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mctrl-local-identity-'));
    tempDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local libSQL identity', () => {
    it('exports only the locked local configuration error codes', () => {
        expect(localDbConfigErrorCodes).toEqual([
            'remote_url',
            'invalid_file_host',
            'invalid_file_port',
            'invalid_file_credentials',
            'invalid_file_query',
            'invalid_file_fragment',
            'unresolvable_file_path',
        ]);
    });

    it('canonicalizes absolute, localhost, and lexical aliases when opening one file', async () => {
        const directory = await makeTempDirectory();
        const databasePath = join(directory, 'canonical.db');
        const canonicalUrl = pathToFileURL(databasePath).href;
        const aliases = [
            `file:${databasePath}`,
            canonicalUrl,
            canonicalUrl.replace('file:///', 'file://localhost/'),
            `file:${join(directory, 'missing', '..', 'canonical.db')}`,
        ];

        const opened = await Promise.all(aliases.map((url) => openLocalLibsqlDb({ url })));

        expect(opened.map((runtime) => runtime.url)).toEqual(aliases.map(() => canonicalUrl));
        expect(opened.map((runtime) => runtime.writeKey)).toEqual(aliases.map(() => canonicalUrl));
        for (const runtime of opened) runtime.close();
    });

    it('canonicalizes a nonexistent database through a symlinked existing parent', async () => {
        const directory = await makeTempDirectory();
        const realParent = join(directory, 'real-parent');
        const aliasParent = join(directory, 'alias-parent');
        await mkdir(realParent);
        await symlink(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
        const canonicalUrl = pathToFileURL(join(realParent, 'canonical.db')).href;

        const opened = await openLocalLibsqlDb({ url: pathToFileURL(join(aliasParent, 'canonical.db')).href });

        expect(opened.url).toBe(canonicalUrl);
        expect(opened.writeKey).toBe(canonicalUrl);
        opened.close();
    });

    it('resolves a relative file URL against the explicit working directory', async () => {
        const directory = await makeTempDirectory();
        const relativePath = join(basename(directory), 'relative.db');
        const canonicalUrl = pathToFileURL(join(directory, 'relative.db')).href;

        const opened = await openLocalLibsqlDb({
            url: `file:${relativePath}`,
            cwd: dirname(directory),
        });

        expect(opened.url).toBe(canonicalUrl);
        expect(opened.writeKey).toBe(canonicalUrl);
        opened.close();
    });

    it('gives every memory open a fresh opaque write identity without resolving its cwd', async () => {
        const impossibleCwd = '\0';

        const first = await openLocalLibsqlDb({ url: ':memory:', cwd: impossibleCwd });
        const second = await openLocalLibsqlDb({ url: ':memory:', cwd: impossibleCwd });

        expect(first.url).toBe(':memory:');
        expect(second.url).toBe(':memory:');
        expect(typeof first.writeKey).toBe('symbol');
        expect(typeof second.writeKey).toBe('symbol');
        expect(first.writeKey).not.toBe(second.writeKey);
        expect(first.client).not.toBe(second.client);
        first.close();
        second.close();
    });

    it('admits transactions for independent memory identities without sharing one lane', async () => {
        const first = await openLocalLibsqlDb({ url: ':memory:' });
        const second = await openLocalLibsqlDb({ url: ':memory:' });
        let releaseFirst = (): void => undefined;
        let markFirstStarted = (): void => undefined;
        let secondStarted = false;
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const firstRelease = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const firstTransaction = runSqliteSessionWriteTransaction({
            runtime: first,
            ensureOpen: () => undefined,
            write: async () => {
                markFirstStarted();
                await firstRelease;
            },
        });
        await firstStarted;
        const secondTransaction = runSqliteSessionWriteTransaction({
            runtime: second,
            ensureOpen: () => undefined,
            write: async () => {
                secondStarted = true;
            },
        });

        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(secondStarted).toBe(true);
        } finally {
            releaseFirst();
            await Promise.allSettled([firstTransaction, secondTransaction]);
            first.close();
            second.close();
        }
    });

    it.each([
        [
            'a regular file used as a parent',
            async (directory: string) => {
                const parent = join(directory, 'not-a-directory');
                await writeFile(parent, 'not a directory', 'utf8');
                return join(parent, 'database.db');
            },
        ],
        [
            'a dangling final symlink',
            async (directory: string) => {
                const target = join(directory, 'missing-target.db');
                const alias = join(directory, 'dangling.db');
                await symlink(target, alias, 'file');
                return alias;
            },
        ],
    ] as const)('rejects an unresolvable path through %s', async (_label, pathForDirectory) => {
        const directory = await makeTempDirectory();
        const databasePath = await pathForDirectory(directory);

        const whenOpening = openLocalLibsqlDb({ url: pathToFileURL(databasePath).href });

        await expect(whenOpening).rejects.toMatchObject({
            code: 'unresolvable_file_path',
            scheme: 'file',
        } satisfies Partial<LocalDbConfigError>);
    });

    it.each([
        ['invalid_file_host', (path: string) => `file://remotehost${path}`],
        ['invalid_file_port', (path: string) => `file://localhost:4567${path}`],
        ['invalid_file_credentials', (path: string) => `file://user:secret@localhost${path}`],
        ['invalid_file_query', (path: string) => `${pathToFileURL(path).href}?mode=ro`],
        ['invalid_file_fragment', (path: string) => `${pathToFileURL(path).href}#fragment`],
        ['unresolvable_file_path', (path: string) => `${pathToFileURL(path).href}%ZZ`],
    ] as const)('returns typed code %s before creating a database', async (code, urlForPath) => {
        const directory = await makeTempDirectory();
        const databasePath = join(directory, 'rejected.db');

        const whenOpening = openLocalLibsqlDb({ url: urlForPath(databasePath) });

        await expect(whenOpening).rejects.toMatchObject({ code, scheme: 'file' } satisfies Partial<LocalDbConfigError>);
        await expect(access(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('reports host rejection before a query on a malformed remote-host file URL', async () => {
        const directory = await makeTempDirectory();
        const databasePath = join(directory, 'rejected.db');

        const whenOpening = openLocalLibsqlDb({ url: `file://remotehost${databasePath}?x=1` });

        await expect(whenOpening).rejects.toMatchObject({
            code: 'invalid_file_host',
            scheme: 'file',
        } satisfies Partial<LocalDbConfigError>);
    });
});
