import { type AgentEvent, SIDECAR_PROTOCOL_VERSION } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../agent-runtime.js';
import { createAllowPermissionDecision } from '../permissions.js';
import { ProcessSidecarClient } from './sidecar-client.js';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

describe('ProcessSidecarClient fallback', () => {
    it('falls back to mock and emits native.warning when spawn fails', async () => {
        const runtime = new AgentRuntime({
            useNative: true,
            sidecarCommand: '/missing/mission-control-sidecar',
            permissionDecisionResolver: createAllowPermissionDecision,
        });
        const events: AgentEvent[] = [];
        runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await runtime.runDemoTask();
        const snapshot = runtime.getSnapshot();

        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['native.warning', 'task.completed']));
        expect(events.find((event) => event.type === 'session.started')?.nativeSidecarStatus).toBe('unknown');
        expect(events.find((event) => event.type === 'native.warning')?.nativeSidecarStatus).toBe('unavailable');
        expect(events.at(-1)?.nativeSidecarStatus).toBe('mock');
        expect(snapshot.lastMessage).toBe('completed by mock sidecar');
        expect(snapshot.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('stops a native sidecar process when the runtime stops', async () => {
        const fixture = await createPersistentSidecarFixture();
        const runtime = new AgentRuntime({
            useNative: true,
            sidecarCommand: fixture.command,
            permissionDecisionResolver: createAllowPermissionDecision,
        });
        let sidecarPid: number | undefined;

        try {
            await runtime.start();
            await runtime.runDemoTask();
            sidecarPid = Number.parseInt(await readFile(fixture.pidFile, 'utf8'), 10);

            expect(isProcessRunning(sidecarPid)).toBe(true);
            await runtime.stop();

            expect(await waitForProcessExit(sidecarPid)).toBe(true);
        } finally {
            if (sidecarPid !== undefined) {
                killIfRunning(sidecarPid);
            }
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects a running task when the native process is stopped', async () => {
        const fixture = await createRunningSidecarFixture();
        const client = new ProcessSidecarClient(fixture.command, 1000);
        let sidecarPid: number | undefined;

        try {
            const runningTask = client.runTask({ id: 'task_1', payload: { label: 'demo' } });
            sidecarPid = await waitForProcessPid(fixture.pidFile);

            expect(isProcessRunning(sidecarPid)).toBe(true);
            await client.stop();

            await expect(runningTask).rejects.toThrow('sidecar exited before completing task');
            expect(await waitForProcessExit(sidecarPid)).toBe(true);
        } finally {
            if (sidecarPid !== undefined) {
                killIfRunning(sidecarPid);
            }
            await client.stop();
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
});

type PersistentSidecarFixture = {
    readonly root: string;
    readonly command: string;
    readonly pidFile: string;
};

async function createPersistentSidecarFixture(): Promise<PersistentSidecarFixture> {
    const root = await mkdtemp(join(tmpdir(), 'mission-control-sidecar-fixture-'));
    const command = join(root, 'sidecar.sh');
    const pidFile = join(root, 'sidecar.pid');
    await writeFile(
        command,
        [
            '#!/usr/bin/env sh',
            `echo "$$" > "${pidFile}"`,
            'while IFS= read -r line; do',
            '  case "$line" in',
            '    *\\"type\\":\\"handshake\\"*)',
            `      echo '{"type":"handshake_completed","id":"handshake_fixture","protocolVersion":${String(SIDECAR_PROTOCOL_VERSION)},"capabilities":["task.run"]}'`,
            '      ;;',
            '    *\\"type\\":\\"run_task\\"*)',
            '      echo \'{"type":"task_completed","id":"task_1","result":{"message":"completed by fixture sidecar"}}\'',
            '      ;;',
            '  esac',
            'done',
            '',
        ].join('\n'),
    );
    await chmod(command, 0o755);
    return { root, command, pidFile };
}

async function createRunningSidecarFixture(): Promise<PersistentSidecarFixture> {
    const root = await mkdtemp(join(tmpdir(), 'mission-control-sidecar-running-fixture-'));
    const command = join(root, 'sidecar.sh');
    const pidFile = join(root, 'sidecar.pid');
    await writeFile(
        command,
        [
            '#!/usr/bin/env sh',
            `echo "$$" > "${pidFile}"`,
            'while IFS= read -r line; do',
            '  case "$line" in',
            '    *\\"type\\":\\"handshake\\"*)',
            `      echo '{"type":"handshake_completed","id":"handshake_fixture","protocolVersion":${String(SIDECAR_PROTOCOL_VERSION)},"capabilities":["task.run"]}'`,
            '      ;;',
            '    *\\"type\\":\\"run_task\\"*)',
            '      sleep 5',
            '      ;;',
            '  esac',
            'done',
            '',
        ].join('\n'),
    );
    await chmod(command, 0o755);
    return { root, command, pidFile };
}

async function waitForProcessPid(pidFile: string): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
            if (Number.isFinite(pid)) {
                return pid;
            }
        } catch (error: unknown) {
            if (errorCode(error) !== 'ENOENT') {
                throw error;
            }
        }
        await delay(25);
    }
    throw new Error('sidecar fixture did not write a pid file');
}

async function waitForProcessExit(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!isProcessRunning(pid)) {
            return true;
        }
        await delay(25);
    }
    return !isProcessRunning(pid);
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        if (errorCode(error) === 'ESRCH') {
            return false;
        }
        throw error;
    }
}

function killIfRunning(pid: number): void {
    try {
        process.kill(pid, 'SIGTERM');
    } catch (error: unknown) {
        if (errorCode(error) !== 'ESRCH') {
            throw error;
        }
    }
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
