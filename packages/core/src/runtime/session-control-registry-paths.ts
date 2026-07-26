import { createHash } from 'node:crypto';
import { isErrorCode } from '../util/node-error';
import { lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_SOCKET_PATH_BYTES = 96;

export type PosixSessionControlPaths = {
    readonly baseDir: string;
    readonly controlDir: string;
    readonly registryDir: string;
    readonly registryPath: string;
    readonly socketDir: string;
    readonly socketPath: string;
};

export type SessionControlRegistryErrorCode =
    | 'directory_create_failed'
    | 'directory_mode_mismatch'
    | 'directory_not_found'
    | 'directory_not_owned'
    | 'directory_not_secure'
    | 'directory_symlink'
    | 'invalid_identity'
    | 'socket_path_too_long'
    | 'unsupported_platform';

export class SessionControlRegistryError extends Error {
    readonly code: SessionControlRegistryErrorCode;
    readonly path: string | undefined;

    constructor(code: SessionControlRegistryErrorCode, message: string, path?: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'SessionControlRegistryError';
        this.code = code;
        this.path = path;
    }
}

export type ResolvePosixSessionControlPathsInput = {
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly xdgRuntimeDir?: string;
    readonly tmpDir?: string;
    readonly shortSocketRoot?: string;
    readonly currentUid?: number;
};

export async function resolvePosixSessionControlPaths(
    input: ResolvePosixSessionControlPathsInput,
): Promise<PosixSessionControlPaths> {
    if (process.platform === 'win32') {
        throw new SessionControlRegistryError('unsupported_platform', 'POSIX session control paths are unavailable');
    }
    validateIdentity(input.dbIdentity, input.sessionId);
    const currentUid = input.currentUid ?? process.getuid?.();
    if (currentUid === undefined) {
        throw new SessionControlRegistryError('directory_not_owned', 'The current POSIX user id is unavailable');
    }

    const xdg = input.xdgRuntimeDir;
    const primary =
        xdg !== undefined && isAbsolute(xdg) && (await isUsableExistingDirectory(xdg, currentUid))
            ? await createControlPaths(xdg, input.dbIdentity, input.sessionId, currentUid)
            : await createFallbackPaths(input, currentUid);
    if (Buffer.byteLength(primary.socketPath) <= MAX_SOCKET_PATH_BYTES) return primary;

    const shortRoot = input.shortSocketRoot ?? '/tmp';
    await assertTemporaryRoot(shortRoot);
    const shortBase = join(shortRoot, `mc-${currentUid}`);
    const shortened = await createControlPaths(shortBase, input.dbIdentity, input.sessionId, currentUid);
    if (Buffer.byteLength(shortened.socketPath) > MAX_SOCKET_PATH_BYTES) {
        throw new SessionControlRegistryError(
            'socket_path_too_long',
            'The secure session control socket path exceeds 96 UTF-8 bytes',
            shortened.socketPath,
        );
    }
    return shortened;
}

async function createFallbackPaths(
    input: ResolvePosixSessionControlPathsInput,
    currentUid: number,
): Promise<PosixSessionControlPaths> {
    const temporaryRoot = input.tmpDir ?? tmpdir();
    await assertTemporaryRoot(temporaryRoot);
    return createControlPaths(
        join(temporaryRoot, `mission-control-${currentUid}`),
        input.dbIdentity,
        input.sessionId,
        currentUid,
    );
}

export function sessionControlSocketName(dbIdentity: string, sessionId: string): string {
    return `${createHash('sha256').update(dbIdentity).update('\0').update(sessionId).digest('hex').slice(0, 32)}.sock`;
}

export function sessionControlRegistryFileName(sessionId: string): string {
    return `${createHash('sha256').update(sessionId, 'utf8').digest('hex')}.json`;
}

async function createControlPaths(
    baseDir: string,
    dbIdentity: string,
    sessionId: string,
    currentUid: number,
): Promise<PosixSessionControlPaths> {
    await ensurePrivateDirectory(baseDir, currentUid);
    const controlDir = join(baseDir, 'control');
    const registryDir = join(controlDir, dbIdentity);
    const socketDir = join(baseDir, 's');
    await ensurePrivateDirectory(controlDir, currentUid);
    await ensurePrivateDirectory(registryDir, currentUid);
    await ensurePrivateDirectory(socketDir, currentUid);
    return {
        baseDir,
        controlDir,
        registryDir,
        registryPath: join(registryDir, sessionControlRegistryFileName(sessionId)),
        socketDir,
        socketPath: join(socketDir, sessionControlSocketName(dbIdentity, sessionId)),
    };
}

async function ensurePrivateDirectory(path: string, currentUid: number): Promise<void> {
    try {
        await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error: unknown) {
        if (!isErrorCode(error, 'EEXIST')) {
            throw new SessionControlRegistryError(
                'directory_create_failed',
                'Failed to create a private session control directory',
                path,
                error,
            );
        }
    }
    await assertPrivateDirectory(path, currentUid);
}

async function isUsableExistingDirectory(path: string, currentUid: number): Promise<boolean> {
    try {
        await assertPrivateDirectory(path, currentUid);
        return true;
    } catch (error: unknown) {
        if (error instanceof SessionControlRegistryError) {
            return false;
        }
        throw error;
    }
}

async function assertPrivateDirectory(path: string, currentUid: number): Promise<void> {
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
        details = await lstat(path);
    } catch (error: unknown) {
        throw new SessionControlRegistryError(
            'directory_not_found',
            'Session control directory is unavailable',
            path,
            error,
        );
    }
    if (details.isSymbolicLink()) {
        throw new SessionControlRegistryError(
            'directory_symlink',
            'Session control directories cannot be symlinks',
            path,
        );
    }
    if (!details.isDirectory()) {
        throw new SessionControlRegistryError('directory_not_secure', 'Session control path is not a directory', path);
    }
    if (details.uid !== currentUid) {
        throw new SessionControlRegistryError(
            'directory_not_owned',
            'Session control directory has another owner',
            path,
        );
    }
    if ((details.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw new SessionControlRegistryError(
            'directory_mode_mismatch',
            'Session control directory mode must be 0700',
            path,
        );
    }
}

async function assertTemporaryRoot(path: string): Promise<void> {
    if (!isAbsolute(path)) {
        throw new SessionControlRegistryError('directory_not_secure', 'Temporary runtime root must be absolute', path);
    }
    let details: Awaited<ReturnType<typeof lstat>>;
    try {
        details = await lstat(path);
    } catch (error: unknown) {
        throw new SessionControlRegistryError(
            'directory_not_found',
            'Temporary runtime root is unavailable',
            path,
            error,
        );
    }
    if (details.isSymbolicLink()) {
        throw new SessionControlRegistryError('directory_symlink', 'Temporary runtime root cannot be a symlink', path);
    }
    if (!details.isDirectory()) {
        throw new SessionControlRegistryError(
            'directory_not_secure',
            'Temporary runtime root is not a directory',
            path,
        );
    }
}

function validateIdentity(dbIdentity: string, sessionId: string): void {
    if (!/^[0-9a-f]{64}$/u.test(dbIdentity) || sessionId.length === 0) {
        throw new SessionControlRegistryError('invalid_identity', 'Invalid session control registry identity');
    }
}


