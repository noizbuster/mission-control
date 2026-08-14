import { missionControlDataDirEnvKey } from '@mission-control/core';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type IsolatedMissionControlTestScope = {
    readonly dataDir: string;
    readonly trackProcess: (child: ChildProcess) => void;
    readonly cleanup: () => Promise<void>;
};

const CHILD_TERMINATION_GRACE_MS = 1_000;

export async function useIsolatedMissionControlTestScope(
    dataDirPrefix: string,
): Promise<IsolatedMissionControlTestScope> {
    const previousDataDir = process.env[missionControlDataDirEnvKey];
    const dataDir = await mkdtemp(join(tmpdir(), dataDirPrefix));
    const childProcesses = new Set<ChildProcess>();
    let cleaned = false;

    process.env[missionControlDataDirEnvKey] = dataDir;

    return {
        dataDir,
        trackProcess: (child: ChildProcess) => {
            childProcesses.add(child);
        },
        cleanup: async () => {
            if (cleaned) return;
            cleaned = true;
            restoreDataDir(previousDataDir);
            await Promise.all([...childProcesses].map(terminateChildProcess));
            // Late session-close writes (title queue, libSQL flush) can land
            // after the test body resolves; ENOTEMPTY retries absorb the race.
            await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        },
    };
}

export async function useIsolatedMissionControlDataDir(prefix: string): Promise<() => Promise<void>> {
    const scope = await useIsolatedMissionControlTestScope(prefix);
    return scope.cleanup;
}

function restoreDataDir(previousDataDir: string | undefined): void {
    if (previousDataDir === undefined) {
        delete process.env[missionControlDataDirEnvKey];
        return;
    }
    process.env[missionControlDataDirEnvKey] = previousDataDir;
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
        let forceKillTimer: NodeJS.Timeout | undefined;
        const cleanup = () => {
            if (forceKillTimer !== undefined) {
                clearTimeout(forceKillTimer);
            }
            child.off('exit', onExit);
            child.off('error', onError);
        };
        const onExit = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        child.once('exit', onExit);
        child.once('error', onError);
        if (!child.kill('SIGTERM')) {
            cleanup();
            resolve();
            return;
        }
        forceKillTimer = setTimeout(() => {
            child.kill('SIGKILL');
        }, CHILD_TERMINATION_GRACE_MS);
    });
}
