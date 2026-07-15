import type { LocalLibsqlDb } from '../db/local-libsql-db';
import { openMissionControlDb } from '../db/mission-control-db';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { missionControlDbPath, missionControlDbUrl } from '../memory/local-session-store-paths';
import {
    recoverExpiredSessionControlOperations,
    type SessionControlOperationTimer,
    startSessionControlOperationGc,
} from './session-control-operation';
import {
    resolveSessionStoreIdentity,
    type SessionStoreIdentity,
    type SessionStoreIdentityPath,
} from './session-store-identity';
import { dirname } from 'node:path';

type ScheduledCallback = () => void | Promise<void>;

type RuntimeSessionControlMaintenance = {
    readonly stop: () => void;
    readonly drainAndClose: () => Promise<void>;
};

type RuntimeLocalDbIdentity = SessionStoreIdentityPath & {
    readonly canonicalDataDir?: string;
};

export type RuntimeSessionControlMaintenanceOptions = {
    readonly nowWallMs?: () => number;
    readonly schedule?: (callback: ScheduledCallback, delayMs: number) => unknown;
    readonly cancel?: (timer: unknown) => void;
    readonly intervalMs?: number;
};

export type OpenCanonicalRuntimeDbOptions = {
    readonly dataDir?: string;
    readonly sessionControlMaintenance?: RuntimeSessionControlMaintenanceOptions | false;
};

export function localRuntimeDbPath(dataDir?: string): string {
    return missionControlDbPath(dataDir);
}

export function localRuntimeDbUrl(dataDir?: string): string {
    return missionControlDbUrl(dataDir);
}

export async function openRuntimeLocalDb(identity: RuntimeLocalDbIdentity): Promise<LocalLibsqlDb> {
    return openMissionControlDb({ dataDir: identity.canonicalDataDir ?? dirname(identity.databasePath) });
}

export async function openCanonicalRuntimeDb(input: OpenCanonicalRuntimeDbOptions = {}): Promise<{
    readonly identity: SessionStoreIdentity;
    readonly runtime: LocalLibsqlDb;
}> {
    const identity = await resolveSessionStoreIdentity({ dataDir: input.dataDir ?? resolveMissionControlDataDir() });
    const runtime = await openRuntimeLocalDb(identity);
    try {
        const maintenance = await startRuntimeSessionControlMaintenance(identity, input.sessionControlMaintenance);
        return { identity, runtime: runtimeWithMaintenance(runtime, maintenance) };
    } catch (error: unknown) {
        runtime.close();
        throw error;
    }
}

async function startRuntimeSessionControlMaintenance(
    identity: SessionStoreIdentityPath,
    options: RuntimeSessionControlMaintenanceOptions | false | undefined,
): Promise<RuntimeSessionControlMaintenance | undefined> {
    if (options === false) return undefined;
    const runtime = await openRuntimeLocalDb(identity);
    try {
        const nowWallMs = options?.nowWallMs ?? (() => Date.now());
        await recoverExpiredSessionControlOperations({ runtime, nowWallMs: nowWallMs() });
        const timer: SessionControlOperationTimer = await startSessionControlOperationGc({
            runtime,
            nowWallMs,
            ...(options?.schedule !== undefined ? { schedule: options.schedule } : {}),
            ...(options?.cancel !== undefined ? { cancel: options.cancel } : {}),
            ...(options?.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
        });
        return {
            stop: timer.stop,
            drainAndClose: async () => {
                await timer.drain();
                runtime.close();
            },
        };
    } catch (error: unknown) {
        runtime.close();
        throw error;
    }
}

function runtimeWithMaintenance(
    runtime: LocalLibsqlDb,
    maintenance: RuntimeSessionControlMaintenance | undefined,
): LocalLibsqlDb {
    if (maintenance === undefined) return runtime;
    let closed = false;
    return {
        ...runtime,
        close: () => {
            if (closed) return;
            closed = true;
            maintenance.stop();
            runtime.close();
            void maintenance.drainAndClose();
        },
    };
}
