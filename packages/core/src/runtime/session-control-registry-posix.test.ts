import { afterEach, describe, expect, it } from 'vitest';
import {
    authenticateSessionControlEndpoint,
    createAuthenticatedSessionControlServer,
    generateSessionControlNonce,
    matchesSessionControlNonce,
} from './session-control-registry-auth';
import {
    publishSessionControlRegistry,
    readSessionControlRegistry,
    serializeSessionControlRegistry,
} from './session-control-registry-file';
import {
    resolvePosixSessionControlPaths,
    SessionControlRegistryError,
    sessionControlRegistryFileName,
} from './session-control-registry-paths';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_IDENTITY = 'b'.repeat(64);
const SESSION_ID = 'registry-session';
const tempDirs: string[] = [];

async function createDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(directory);
    await chmod(directory, 0o700);
    return directory;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.runIf(process.platform !== 'win32')('POSIX session control registry', () => {
    it('uses a secure absolute XDG runtime dir and creates private namespaced paths', async () => {
        const xdgRuntimeDir = await createDirectory('mctrl-control-xdg-');

        const paths = await resolvePosixSessionControlPaths({
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            xdgRuntimeDir,
        });

        expect(paths.baseDir).toBe(xdgRuntimeDir);
        expect(paths.socketPath).toMatch(/\/s\/[0-9a-f]{32}\.sock$/u);
        expect(paths.registryPath).toBe(
            join(xdgRuntimeDir, 'control', DB_IDENTITY, sessionControlRegistryFileName(SESSION_ID)),
        );
        expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(96);
        await expect(lstat(paths.socketDir)).resolves.toMatchObject({ mode: expect.any(Number) });
        expect((await lstat(paths.socketDir)).mode & 0o777).toBe(0o700);
        expect((await lstat(paths.registryDir)).mode & 0o777).toBe(0o700);
    });

    it('falls back from an unusable XDG candidate and refuses an insecure fallback', async () => {
        const fallbackParent = await createDirectory('mctrl-control-fallback-parent-');
        const insecure = join(fallbackParent, `mission-control-${process.getuid?.() ?? 0}`);
        await mkdir(insecure, { mode: 0o755 });

        await expect(
            resolvePosixSessionControlPaths({
                dbIdentity: DB_IDENTITY,
                sessionId: SESSION_ID,
                xdgRuntimeDir: 'relative/runtime',
                tmpDir: fallbackParent,
            }),
        ).rejects.toMatchObject({
            code: 'directory_mode_mismatch',
            path: insecure,
        } satisfies Partial<SessionControlRegistryError>);
    });

    it('refuses a runtime directory not owned by the expected uid', async () => {
        const fallbackParent = await createDirectory('mctrl-control-owner-parent-');

        await expect(
            resolvePosixSessionControlPaths({
                dbIdentity: DB_IDENTITY,
                sessionId: SESSION_ID,
                tmpDir: fallbackParent,
                currentUid: (process.getuid?.() ?? 0) + 1,
            }),
        ).rejects.toMatchObject({ code: 'directory_not_owned' } satisfies Partial<SessionControlRegistryError>);
    });

    it('uses the short secure fallback when the selected socket path exceeds 96 UTF-8 bytes', async () => {
        const root = await createDirectory('mctrl-control-long-root-');
        const xdgRuntimeDir = join(root, 'x'.repeat(80));
        const shortSocketRoot = await createDirectory('mctrl-control-short-root-');
        await mkdir(xdgRuntimeDir, { mode: 0o700 });

        const paths = await resolvePosixSessionControlPaths({
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            xdgRuntimeDir,
            shortSocketRoot,
        });

        expect(paths.baseDir).toBe(join(shortSocketRoot, `mc-${process.getuid?.() ?? 0}`));
        expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(96);
        expect((await lstat(paths.baseDir)).mode & 0o777).toBe(0o700);
    });

    it('refuses symlinked runtime directories', async () => {
        const root = await createDirectory('mctrl-control-symlink-');
        const target = join(root, 'target');
        const link = join(root, 'link');
        await chmod(root, 0o700);
        await mkdir(target, { mode: 0o700 });
        await symlink(target, link, 'dir');

        await expect(
            resolvePosixSessionControlPaths({
                dbIdentity: DB_IDENTITY,
                sessionId: SESSION_ID,
                xdgRuntimeDir: link,
                tmpDir: link,
            }),
        ).rejects.toMatchObject({ code: 'directory_symlink' } satisfies Partial<SessionControlRegistryError>);
    });

    it('publishes exact ordered compact JSON after a mode-0600 socket is visible', async () => {
        const xdgRuntimeDir = await createDirectory('mctrl-control-publish-');
        const paths = await resolvePosixSessionControlPaths({
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            xdgRuntimeDir,
        });
        const nonce = generateSessionControlNonce();
        const server = await createAuthenticatedSessionControlServer({
            socketPath: paths.socketPath,
            nonce,
            ownerId: 'owner-one',
            epoch: 7,
        });
        const registry = {
            endpoint: paths.socketPath,
            nonce,
            owner_id: 'owner-one',
            epoch: 7,
            pid: process.pid,
            process_start_id: 'process-start',
            heartbeat_wall_ms: 1_000,
            expires_wall_ms: 16_000,
        } as const;
        const publishPhases: string[] = [];

        await publishSessionControlRegistry(paths.registryPath, registry, {
            beforeRename: async () => {
                expect((await lstat(paths.socketPath)).mode & 0o777).toBe(0o600);
            },
            onPhase: (phase) => publishPhases.push(phase),
        });
        const bytes = await readFile(paths.registryPath, 'utf8');

        expect(bytes).toBe(serializeSessionControlRegistry(registry));
        expect(publishPhases).toEqual(['temporary_opened', 'file_datasynced', 'renamed', 'directory_fsynced']);
        expect(bytes).toBe(
            `{"endpoint":"${paths.socketPath}","nonce":"${nonce}","owner_id":"owner-one","epoch":7,"pid":${process.pid},"process_start_id":"process-start","heartbeat_wall_ms":1000,"expires_wall_ms":16000}`,
        );
        expect((await lstat(paths.registryPath)).mode & 0o777).toBe(0o600);
        expect(await readSessionControlRegistry(paths.registryPath)).toEqual(registry);
        await expect(
            readSessionControlRegistry(paths.registryPath, { currentUid: (process.getuid?.() ?? 0) + 1 }),
        ).rejects.toMatchObject({ code: 'directory_not_owned' });
        await server.close();
    });

    it('authenticates decoded nonce bytes and rejects forged nonce or old epoch', async () => {
        const xdgRuntimeDir = await createDirectory('mctrl-control-auth-');
        const paths = await resolvePosixSessionControlPaths({
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            xdgRuntimeDir,
        });
        const nonce = generateSessionControlNonce();
        const server = await createAuthenticatedSessionControlServer({
            socketPath: paths.socketPath,
            nonce,
            ownerId: 'owner-one',
            epoch: 2,
        });
        const registry = {
            endpoint: paths.socketPath,
            nonce,
            owner_id: 'owner-one',
            epoch: 2,
            pid: process.pid,
            process_start_id: 'process-start',
            heartbeat_wall_ms: 1_000,
            expires_wall_ms: 16_000,
        } as const;

        expect(matchesSessionControlNonce(nonce, nonce)).toBe(true);
        expect(matchesSessionControlNonce(nonce, generateSessionControlNonce())).toBe(false);
        await expect(authenticateSessionControlEndpoint(registry)).resolves.toBe(true);
        await expect(
            authenticateSessionControlEndpoint({ ...registry, nonce: generateSessionControlNonce() }),
        ).resolves.toBe(false);
        await expect(authenticateSessionControlEndpoint({ ...registry, epoch: 1 })).resolves.toBe(false);
        await server.close();
    });
});
