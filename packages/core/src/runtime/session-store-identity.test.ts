import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    formatPermissiveDataDirWarning,
    resetDataDirPermissionWarningStateForTests,
    resolveSessionStoreIdentity,
    SESSION_STORE_IDENTITY_GOLDEN_VECTORS,
    SessionStoreIdentityError,
    sessionStoreDatabasePath,
    sessionStoreIdentityFromCanonicalDatabasePath,
    takeDataDirPermissionWarnings,
} from './session-store-identity';
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
        expect(warnings[0]).toContain(`Fix: chmod 700 ${JSON.stringify(dataDir)}`);
        expect((await stat(dataDir)).mode & 0o777).toBe(0o755);
    });

    it('collects default permissive-mode warnings once without process.emitWarning', async () => {
        resetDataDirPermissionWarningStateForTests();
        const dataDir = await makeTempDir('mctrl-identity-mode-default-');
        await chmod(dataDir, 0o775);
        const emitWarning = vi.spyOn(process, 'emitWarning');

        await resolveSessionStoreIdentity({ dataDir, platform: 'linux' });
        await resolveSessionStoreIdentity({ dataDir, platform: 'linux' });

        expect(emitWarning).not.toHaveBeenCalled();
        const firstTake = takeDataDirPermissionWarnings();
        expect(firstTake).toHaveLength(1);
        expect(firstTake[0]).toContain('0775');
        expect(firstTake[0]).toContain('Fix: chmod 700');
        expect(takeDataDirPermissionWarnings()).toEqual([]);
        await resolveSessionStoreIdentity({ dataDir, platform: 'linux' });
        expect(takeDataDirPermissionWarnings()).toEqual([]);
        emitWarning.mockRestore();
        resetDataDirPermissionWarningStateForTests();
    });

    it('formats a remediating chmod command for permissive data dirs', () => {
        expect(formatPermissiveDataDirWarning('/home/alice/.local/share/mission-control', 0o775)).toBe(
            'Mission Control data directory /home/alice/.local/share/mission-control has permissive mode 0775; permissions were not changed. Fix: chmod 700 "/home/alice/.local/share/mission-control"',
        );
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
                inputDatabasePath: '/home/alice/.local/share/mission-control/mission-control.db',
                databasePath: '/home/alice/.local/share/mission-control/mission-control.db',
                databaseFileUrl: 'file:///home/alice/.local/share/mission-control/mission-control.db',
                dbIdentity: '6317fdfef52d195bb6bddd5ce82484ac9abd4d4b567fb85a4ab06d867ea94392',
            },
            {
                name: 'windows-drive',
                platform: 'win32',
                inputDatabasePath: 'c:\\Users\\Alice\\AppData\\Roaming\\mission-control\\mission-control.db',
                databasePath: 'C:\\Users\\Alice\\AppData\\Roaming\\mission-control\\mission-control.db',
                databaseFileUrl: 'file:///C:/Users/Alice/AppData/Roaming/mission-control/mission-control.db',
                dbIdentity: 'e096f04ec938133c55f50210fed3db6b750e43dd8a2478ae6de818a24f9b9cda',
            },
            {
                name: 'windows-unc',
                platform: 'win32',
                inputDatabasePath: '\\\\SERVER\\Team Share\\mission-control\\mission-control.db',
                databasePath: '\\\\SERVER\\Team Share\\mission-control\\mission-control.db',
                databaseFileUrl: 'file://server/Team%20Share/mission-control/mission-control.db',
                dbIdentity: 'e0efcad44653d3d93081f8e8e6a6850cd0ed82e4ca7d00d8a1a1c5b5f3c4878b',
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

describe('canonical Mission Control database opener audit', () => {
    it('rejects independent production database filename joins and direct libSQL client openers', async () => {
        const sourceRoot = join(process.cwd(), 'packages', 'core', 'src');
        const entries = await readdir(sourceRoot, { recursive: true });
        const sourcePaths = entries
            .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
            .map((entry) => join(sourceRoot, entry));
        const violations: string[] = [];

        for (const sourcePath of sourcePaths) {
            const contents = await readFile(sourcePath, 'utf8');
            const relativePath = sourcePath.slice(sourceRoot.length + 1);
            if (/\b(?:join|resolve)\([^;\n]*['"]memory\.db['"]/u.test(contents)) {
                violations.push(`${relativePath}: legacy memory.db path join`);
            }
            if (/\bconst\s+[A-Z0-9_]*DB_FILENAME\s*=\s*['"]memory\.db['"]/u.test(contents)) {
                violations.push(`${relativePath}: legacy memory.db filename`);
            }
            if (relativePath !== 'runtime/session-store-identity.ts') {
                if (/\b(?:join|resolve)\([^;\n]*['"]mission-control\.db['"]/u.test(contents)) {
                    violations.push(`${relativePath}: independent mission-control.db path join`);
                }
                if (/\bconst\s+[A-Z0-9_]*DB_FILENAME\s*=\s*['"]mission-control\.db['"]/u.test(contents)) {
                    violations.push(`${relativePath}: independent mission-control.db filename`);
                }
            }
            if (relativePath !== 'db/local-libsql-db.ts' && /\bcreateClient\s*\(\s*\{\s*url\b/u.test(contents)) {
                violations.push(`${relativePath}: direct libSQL client opener`);
            }
        }

        expect(violations).toEqual([]);
    });
});
