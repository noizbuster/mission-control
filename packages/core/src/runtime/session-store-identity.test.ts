import { afterEach, describe, expect, it } from 'vitest';
import {
    resolveSessionStoreIdentity,
    SESSION_STORE_IDENTITY_GOLDEN_VECTORS,
    SessionStoreIdentityError,
    sessionStoreDatabasePath,
    sessionStoreIdentityFromCanonicalDatabasePath,
} from './session-store-identity.js';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

describe('SessionStoreIdentity', () => {
    it('creates an absent data directory with POSIX 0700 and hashes its canonical file URL', async () => {
        const parent = await makeTempDir('mctrl-identity-parent-');
        const dataDir = join(parent, 'new-data-dir');

        const identity = await resolveSessionStoreIdentity({ dataDir, platform: 'linux' });

        const canonicalDataDir = await import('node:fs/promises').then(({ realpath }) => realpath(dataDir));
        const expectedPath = join(canonicalDataDir, basename(sessionStoreDatabasePath('/')));
        const expectedUrl = pathToFileURL(expectedPath).href;
        expect(identity).toEqual({
            canonicalDataDir,
            databasePath: expectedPath,
            databaseFileUrl: expectedUrl,
            dbIdentity: createHash('sha256').update(expectedUrl, 'utf8').digest('hex'),
        });
        expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    });

    it('uses realpath.native for an existing database reached through a data-directory symlink', async () => {
        const parent = await makeTempDir('mctrl-identity-symlink-');
        const target = join(parent, 'target');
        const alias = join(parent, 'alias');
        await mkdir(target, { mode: 0o700 });
        const databasePath = sessionStoreDatabasePath(target);
        await writeFile(databasePath, '', 'utf8');
        await symlink(target, alias, 'dir');

        const identity = await resolveSessionStoreIdentity({ dataDir: alias, platform: 'linux' });

        expect(identity.canonicalDataDir).toBe(target);
        expect(identity.databasePath).toBe(databasePath);
        expect(identity.databaseFileUrl).toBe(pathToFileURL(databasePath).href);
    });

    it('warns about permissive existing POSIX roots without changing their mode', async () => {
        const dataDir = await makeTempDir('mctrl-identity-mode-');
        await chmod(dataDir, 0o755);
        const warnings: string[] = [];

        await resolveSessionStoreIdentity({
            dataDir,
            platform: 'linux',
            warn: (message) => warnings.push(message),
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('0755');
        expect((await stat(dataDir)).mode & 0o777).toBe(0o755);
    });

    it('fails closed when an existing POSIX root is not owned by the current user', async () => {
        const dataDir = await makeTempDir('mctrl-identity-owner-');
        const actualUid = (await stat(dataDir)).uid;

        await expect(
            resolveSessionStoreIdentity({ dataDir, platform: 'linux', currentUid: actualUid + 1 }),
        ).rejects.toMatchObject({ code: 'data_dir_owner_mismatch' } satisfies Partial<SessionStoreIdentityError>);
    });

    it('exports stable POSIX, Windows drive, and UNC golden vectors', () => {
        expect(SESSION_STORE_IDENTITY_GOLDEN_VECTORS).toEqual([
            {
                name: 'posix-default',
                platform: 'linux',
                inputDatabasePath: '/home/alice/.local/share/mission-control/memory.db',
                databasePath: '/home/alice/.local/share/mission-control/memory.db',
                databaseFileUrl: 'file:///home/alice/.local/share/mission-control/memory.db',
                dbIdentity: '8df978b1b91de5716a7aa2b1421579d3ad84cb4b8fef3002a21c340e44094f3b',
            },
            {
                name: 'windows-drive',
                platform: 'win32',
                inputDatabasePath: 'c:\\Users\\Alice\\AppData\\Roaming\\mission-control\\memory.db',
                databasePath: 'C:\\Users\\Alice\\AppData\\Roaming\\mission-control\\memory.db',
                databaseFileUrl: 'file:///C:/Users/Alice/AppData/Roaming/mission-control/memory.db',
                dbIdentity: '488afdd858d13406509f2689433ec2304dd6d8b25cda0a0c05a6364eec481bee',
            },
            {
                name: 'windows-unc',
                platform: 'win32',
                inputDatabasePath: '\\\\SERVER\\Team Share\\mission-control\\memory.db',
                databasePath: '\\\\SERVER\\Team Share\\mission-control\\memory.db',
                databaseFileUrl: 'file://server/Team%20Share/mission-control/memory.db',
                dbIdentity: '5d85abad1b8a4618d5e8ec55d636f9106cba3e8e4ddef0b89c41d22822b5fca0',
            },
        ]);

        for (const vector of SESSION_STORE_IDENTITY_GOLDEN_VECTORS) {
            expect(sessionStoreIdentityFromCanonicalDatabasePath(vector.inputDatabasePath, vector.platform)).toEqual({
                databasePath: vector.databasePath,
                databaseFileUrl: vector.databaseFileUrl,
                dbIdentity: vector.dbIdentity,
            });
        }
    });
});

describe('canonical memory database opener audit', () => {
    it('rejects independent production memory.db joins and direct libSQL client openers', async () => {
        const sourceRoot = join(process.cwd(), 'packages', 'core', 'src');
        const entries = await readdir(sourceRoot, { recursive: true });
        const sourcePaths = entries
            .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
            .map((entry) => join(sourceRoot, entry));
        const violations: string[] = [];

        for (const sourcePath of sourcePaths) {
            const contents = await readFile(sourcePath, 'utf8');
            const relativePath = sourcePath.slice(sourceRoot.length + 1);
            if (relativePath !== 'runtime/session-store-identity.ts') {
                if (/\b(?:join|resolve)\([^;\n]*['"]memory\.db['"]/u.test(contents)) {
                    violations.push(`${relativePath}: independent memory.db path join`);
                }
                if (/\bconst\s+[A-Z0-9_]*DB_FILENAME\s*=\s*['"]memory\.db['"]/u.test(contents)) {
                    violations.push(`${relativePath}: independent memory.db filename`);
                }
            }
            if (relativePath !== 'db/local-libsql-db.ts' && /\bcreateClient\s*\(\s*\{\s*url\b/u.test(contents)) {
                violations.push(`${relativePath}: direct libSQL client opener`);
            }
        }

        expect(violations).toEqual([]);
    });
});
