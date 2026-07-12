import { RuntimeDbMigrationError } from './runtime-db-migration-error.js';
import { realpathNative } from './session-store-identity.js';
import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';

export async function requireDirectLegacyDirectory(path: string): Promise<boolean> {
    const details = await optionalLstat(path);
    if (details === undefined) return false;
    if (!details.isDirectory() || (await realpathNative(path)) !== path) {
        throw unsafeRunSource(path, `Legacy run directory must be a direct directory: ${path}`);
    }
    return true;
}

export async function readDirectLegacyRunFile(path: string): Promise<Uint8Array> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
        const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
        handle = await open(path, constants.O_RDONLY | noFollow);
    } catch (error: unknown) {
        throw unsafeRunSource(path, `Legacy run source must be a direct regular file: ${path}`, error);
    }
    try {
        const descriptorDetails = await handle.stat();
        if (!descriptorDetails.isFile() || (await realpathNative(path)) !== path) {
            throw unsafeRunSource(path, `Legacy run source must be a direct regular file: ${path}`);
        }
        const pathDetails = await stat(path);
        if (pathDetails.dev !== descriptorDetails.dev || pathDetails.ino !== descriptorDetails.ino) {
            throw unsafeRunSource(path, `Legacy run source changed during discovery: ${path}`);
        }
        return await handle.readFile();
    } catch (error: unknown) {
        if (error instanceof RuntimeDbMigrationError) throw error;
        throw unsafeRunSource(path, `Legacy run source could not be read safely: ${path}`, error);
    } finally {
        await handle.close();
    }
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    try {
        return await lstat(path);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw error;
    }
}

function unsafeRunSource(path: string, message: string, cause?: unknown): RuntimeDbMigrationError {
    return new RuntimeDbMigrationError({
        code: 'legacy_run_unsafe',
        path,
        message,
        ...(cause !== undefined ? { cause } : {}),
    });
}

function isErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
