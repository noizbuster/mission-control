import { missionControlDataDirEnvKey } from '@mission-control/core';
import { describe, expect, it } from 'vitest';
import { useIsolatedMissionControlTestScope } from './run-agent-data-dir-test-support';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('run-agent data dir test support', () => {
    it('restores MCTRL_DATA_DIR and removes the isolated data dir during cleanup', async () => {
        const previousDataDir = process.env[missionControlDataDirEnvKey];
        const scope = await useIsolatedMissionControlTestScope('mctrl-test-support-data-');

        expect(process.env[missionControlDataDirEnvKey]).toBe(scope.dataDir);
        await expect(access(scope.dataDir)).resolves.toBeUndefined();

        await scope.cleanup();

        expect(process.env[missionControlDataDirEnvKey]).toBe(previousDataDir);
        await expect(access(scope.dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('terminates tracked child processes during cleanup', async () => {
        const scope = await useIsolatedMissionControlTestScope('mctrl-test-support-process-data-');
        const child = spawn(process.execPath, ['--eval', 'setInterval(() => undefined, 1000)'], {
            cwd: tmpdir(),
            stdio: 'ignore',
        });
        scope.trackProcess(child);

        await scope.cleanup();

        expect(child.killed).toBe(true);
        expect(child.exitCode === null && child.signalCode === null).toBe(false);
    });

    it('force kills tracked child processes that ignore SIGTERM', async () => {
        const scope = await useIsolatedMissionControlTestScope('mctrl-test-support-stubborn-process-data-');
        const child = spawn(
            process.execPath,
            [
                '--eval',
                "process.on('SIGTERM', () => undefined); process.stdout.write('ready\\n'); setInterval(() => undefined, 1000)",
            ],
            {
                cwd: tmpdir(),
                stdio: ['ignore', 'pipe', 'ignore'],
            },
        );
        scope.trackProcess(child);
        await waitForChildStdout(child);

        await scope.cleanup();

        expect(child.killed).toBe(true);
        expect(child.signalCode).toBe('SIGKILL');
    });

    it('cleanup is idempotent', async () => {
        const scope = await useIsolatedMissionControlTestScope('mctrl-test-support-idempotent-');

        await scope.cleanup();

        await expect(scope.cleanup()).resolves.toBeUndefined();
    });
});

async function waitForChildStdout(child: ChildProcess): Promise<void> {
    const stdout = child.stdout;
    if (stdout === null) {
        throw new Error('expected child stdout pipe');
    }
    await once(stdout, 'data');
}
