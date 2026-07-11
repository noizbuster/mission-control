import { createHash } from 'node:crypto';
import { lstat as lstatCallback, realpath as realpathCallback } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SESSION_STORE_DATABASE_FILENAME = 'memory.db';
const DATA_DIR_PRIVATE_MODE = 0o700;
const DATA_DIR_PERMISSION_MASK = 0o077;

export type SessionStoreIdentity = {
    readonly canonicalDataDir: string;
    readonly databasePath: string;
    readonly databaseFileUrl: string;
    readonly dbIdentity: string;
};

export type SessionStoreIdentityPath = Omit<SessionStoreIdentity, 'canonicalDataDir'>;

export const sessionStoreIdentityErrorCodes = [
    'data_dir_create_failed',
    'data_dir_realpath_failed',
    'data_dir_stat_failed',
    'data_dir_owner_mismatch',
    'database_realpath_failed',
] as const;
export type SessionStoreIdentityErrorCode = (typeof sessionStoreIdentityErrorCodes)[number];

export class SessionStoreIdentityError extends Error {
    readonly code: SessionStoreIdentityErrorCode;
    readonly path: string;

    constructor(input: {
        readonly code: SessionStoreIdentityErrorCode;
        readonly path: string;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
        this.name = 'SessionStoreIdentityError';
        this.code = input.code;
        this.path = input.path;
    }
}

export type ResolveSessionStoreIdentityOptions = {
    readonly dataDir: string;
    readonly platform?: NodeJS.Platform;
    readonly currentUid?: number;
    readonly warn?: (message: string) => void;
};

export type SessionStoreIdentityGoldenVector = {
    readonly name: string;
    readonly platform: NodeJS.Platform;
    readonly inputDatabasePath: string;
    readonly databasePath: string;
    readonly databaseFileUrl: string;
    readonly dbIdentity: string;
};

export const SESSION_STORE_IDENTITY_GOLDEN_VECTORS: readonly SessionStoreIdentityGoldenVector[] = [
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
];

export function sessionStoreDatabasePath(dataDir: string): string {
    return join(dataDir, SESSION_STORE_DATABASE_FILENAME);
}

export function sessionStoreIdentityFromCanonicalDatabasePath(
    inputDatabasePath: string,
    platform: NodeJS.Platform = process.platform,
): SessionStoreIdentityPath {
    const databasePath = platform === 'win32' ? uppercaseWindowsDrive(inputDatabasePath) : inputDatabasePath;
    const fileUrl = pathToFileURL(databasePath, { windows: platform === 'win32' });
    if (fileUrl.hostname.length > 0) {
        fileUrl.hostname = fileUrl.hostname.toLowerCase();
    }
    const databaseFileUrl = fileUrl.href;
    return {
        databasePath,
        databaseFileUrl,
        dbIdentity: createHash('sha256').update(databaseFileUrl, 'utf8').digest('hex'),
    };
}

export async function resolveSessionStoreIdentity(
    options: ResolveSessionStoreIdentityOptions,
): Promise<SessionStoreIdentity> {
    const platform = options.platform ?? process.platform;
    const existed = await pathExists(options.dataDir);
    if (!existed) {
        try {
            await mkdir(options.dataDir, { recursive: true, mode: DATA_DIR_PRIVATE_MODE });
        } catch (error: unknown) {
            throw new SessionStoreIdentityError({
                code: 'data_dir_create_failed',
                path: options.dataDir,
                message: `Failed to create Mission Control data directory ${options.dataDir}`,
                cause: error,
            });
        }
    }

    const canonicalDataDir = await canonicalPath(options.dataDir, 'data_dir_realpath_failed');
    if (platform !== 'win32') {
        const currentUid = options.currentUid ?? process.getuid?.();
        await verifyPosixDataDir({
            canonicalDataDir,
            ...(currentUid !== undefined ? { currentUid } : {}),
            warn: options.warn ?? defaultPermissionWarning,
        });
    }

    const unresolvedDatabasePath = sessionStoreDatabasePath(canonicalDataDir);
    const databasePath = (await pathExists(unresolvedDatabasePath))
        ? await canonicalPath(unresolvedDatabasePath, 'database_realpath_failed')
        : unresolvedDatabasePath;
    return {
        canonicalDataDir,
        ...sessionStoreIdentityFromCanonicalDatabasePath(databasePath, platform),
    };
}

async function verifyPosixDataDir(input: {
    readonly canonicalDataDir: string;
    readonly currentUid?: number;
    readonly warn: (message: string) => void;
}): Promise<void> {
    let details: Awaited<ReturnType<typeof stat>>;
    try {
        details = await stat(input.canonicalDataDir);
    } catch (error: unknown) {
        throw new SessionStoreIdentityError({
            code: 'data_dir_stat_failed',
            path: input.canonicalDataDir,
            message: `Failed to inspect Mission Control data directory ${input.canonicalDataDir}`,
            cause: error,
        });
    }
    if (input.currentUid !== undefined && details.uid !== input.currentUid) {
        throw new SessionStoreIdentityError({
            code: 'data_dir_owner_mismatch',
            path: input.canonicalDataDir,
            message: `Mission Control data directory ${input.canonicalDataDir} is not owned by the current user`,
        });
    }
    const mode = details.mode & 0o777;
    if ((mode & DATA_DIR_PERMISSION_MASK) !== 0) {
        input.warn(
            `Mission Control data directory ${input.canonicalDataDir} has permissive mode 0${mode
                .toString(8)
                .padStart(3, '0')}; permissions were not changed`,
        );
    }
}

function defaultPermissionWarning(message: string): void {
    process.emitWarning(message, { code: 'MCTRL_DATA_DIR_PERMISSIONS' });
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstatNative(path);
        return true;
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return false;
        }
        throw error;
    }
}

async function canonicalPath(path: string, code: SessionStoreIdentityErrorCode): Promise<string> {
    try {
        return await realpathNative(path);
    } catch (error: unknown) {
        throw new SessionStoreIdentityError({
            code,
            path,
            message: `Failed to canonicalize ${path}`,
            cause: error,
        });
    }
}

export function realpathNative(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        realpathCallback.native(path, (error, resolvedPath) => {
            if (error !== null) {
                reject(error);
                return;
            }
            resolve(resolvedPath);
        });
    });
}

function lstatNative(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        lstatCallback(path, (error) => {
            if (error !== null) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function uppercaseWindowsDrive(path: string): string {
    if (!/^[A-Za-z]:[\\/]/u.test(path)) {
        return path;
    }
    return `${path[0]?.toUpperCase() ?? ''}${path.slice(1)}`;
}

function isErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
