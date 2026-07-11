import { z } from 'zod';
import { SessionControlRegistryError } from './session-control-registry-paths.js';
import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

export type SessionControlRegistry = {
    readonly endpoint: string;
    readonly nonce: string;
    readonly owner_id: string;
    readonly epoch: number;
    readonly pid: number;
    readonly process_start_id: string;
    readonly heartbeat_wall_ms: number;
    readonly expires_wall_ms: number;
};

type PublishSessionControlRegistryOptions = {
    readonly beforeRename?: () => Promise<void> | void;
    readonly onPhase?: (phase: 'directory_fsynced' | 'file_datasynced' | 'renamed' | 'temporary_opened') => void;
    readonly syncDirectory?: boolean;
};

const registrySchema = z
    .object({
        endpoint: z.string().min(1),
        nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        owner_id: z.string().min(1),
        epoch: z.number().int().positive(),
        pid: z.number().int().nonnegative(),
        process_start_id: z.string().min(1),
        heartbeat_wall_ms: z.number().int().nonnegative(),
        expires_wall_ms: z.number().int().nonnegative(),
    })
    .strict();

export function serializeSessionControlRegistry(registry: SessionControlRegistry): string {
    const parsed = registrySchema.parse(registry);
    return JSON.stringify({
        endpoint: parsed.endpoint,
        nonce: parsed.nonce,
        owner_id: parsed.owner_id,
        epoch: parsed.epoch,
        pid: parsed.pid,
        process_start_id: parsed.process_start_id,
        heartbeat_wall_ms: parsed.heartbeat_wall_ms,
        expires_wall_ms: parsed.expires_wall_ms,
    });
}

export async function publishSessionControlRegistry(
    registryPath: string,
    registry: SessionControlRegistry,
    options: PublishSessionControlRegistryOptions = {},
): Promise<void> {
    const registryBytes = serializeSessionControlRegistry(registry);
    const directory = dirname(registryPath);
    const temporaryPath = `${directory}/.${basename(registryPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    const temporary = await open(temporaryPath, 'wx', 0o600);
    let closed = false;
    try {
        options.onPhase?.('temporary_opened');
        await temporary.writeFile(registryBytes, 'utf8');
        await temporary.datasync();
        options.onPhase?.('file_datasynced');
        await temporary.close();
        closed = true;
        await options.beforeRename?.();
        await rename(temporaryPath, registryPath);
        options.onPhase?.('renamed');
        if (options.syncDirectory ?? true) {
            const directoryHandle = await open(directory, 'r');
            try {
                await directoryHandle.sync();
                options.onPhase?.('directory_fsynced');
            } finally {
                await directoryHandle.close();
            }
        }
    } catch (error: unknown) {
        if (!closed) {
            await temporary.close().catch(() => undefined);
        }
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw new SessionControlRegistryError(
            'directory_not_secure',
            'Failed to atomically publish the session control registry',
            registryPath,
            error,
        );
    }
}

export async function readSessionControlRegistry(
    registryPath: string,
    options: { readonly currentUid?: number; readonly verifyPosixMetadata?: boolean } = {},
): Promise<SessionControlRegistry> {
    const details = await lstat(registryPath);
    if (details.isSymbolicLink() || !details.isFile()) {
        throw new SessionControlRegistryError(
            'directory_not_secure',
            'Session control registry must be a regular file',
            registryPath,
        );
    }
    if (options.verifyPosixMetadata ?? process.platform !== 'win32') {
        const currentUid = options.currentUid ?? process.getuid?.();
        if (currentUid !== undefined && details.uid !== currentUid) {
            throw new SessionControlRegistryError(
                'directory_not_owned',
                'Session control registry has another owner',
                registryPath,
            );
        }
        if ((details.mode & 0o777) !== 0o600) {
            throw new SessionControlRegistryError(
                'directory_mode_mismatch',
                'Session control registry mode must be 0600',
                registryPath,
            );
        }
    }
    try {
        return registrySchema.parse(JSON.parse(await readFile(registryPath, 'utf8')));
    } catch {
        throw new SessionControlRegistryError(
            'directory_not_secure',
            'Session control registry content is invalid',
            registryPath,
        );
    }
}
