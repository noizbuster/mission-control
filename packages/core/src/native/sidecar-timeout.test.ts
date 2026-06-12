import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../agent-runtime.js';
import { createAllowPermissionDecision } from '../permissions.js';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();

describe('sidecar timeout fallback', () => {
    it('emits native.warning and falls back to mock when the sidecar hangs', async () => {
        const runtime = new AgentRuntime({
            useNative: true,
            sidecarCommand: join(root, 'scripts/fixtures/hanging-sidecar.sh'),
            sidecarTimeoutMs: 50,
            permissionDecisionResolver: createAllowPermissionDecision,
        });
        const events: AgentEvent[] = [];
        runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await runtime.runDemoTask();

        const warning = events.find((event) => event.type === 'native.warning');
        expect(warning?.message).toContain('timed out');
        expect(events.at(-1)?.type).toBe('task.completed');
        expect(runtime.getSnapshot().lastMessage).toBe('completed by mock sidecar');
    });

    it('falls back to mock when the sidecar emits only a partial response', async () => {
        const fixture = await createSidecarFixture([
            '#!/usr/bin/env sh',
            'while IFS= read -r line; do',
            '  case "$line" in',
            '    *\\"type\\":\\"handshake\\"*)',
            '      echo \'{"type":"handshake_completed","id":"handshake_fixture","protocolVersion":1,"capabilities":["task.run"]}\'',
            '      ;;',
            '    *\\"type\\":\\"run_task\\"*)',
            '      printf \'{"type":"task_completed","id":"task_demo","result":{"message":"unfinished"\'',
            '      sleep 1',
            '      ;;',
            '  esac',
            'done',
            '',
        ]);

        try {
            const events = await runDemoWithSidecar(fixture.command, 50);

            expect(events.find((event) => event.type === 'native.warning')?.message).toContain('timed out');
            expect(events.filter((event) => event.type === 'task.completed').at(-1)?.nativeSidecarStatus).toBe('mock');
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('falls back to mock when the sidecar exits before task completion', async () => {
        const fixture = await createSidecarFixture([
            '#!/usr/bin/env sh',
            'while IFS= read -r line; do',
            '  case "$line" in',
            '    *\\"type\\":\\"handshake\\"*)',
            '      echo \'{"type":"handshake_completed","id":"handshake_fixture","protocolVersion":1,"capabilities":["task.run"]}\'',
            '      ;;',
            '    *\\"type\\":\\"run_task\\"*)',
            '      exit 7',
            '      ;;',
            '  esac',
            'done',
            '',
        ]);

        try {
            const events = await runDemoWithSidecar(fixture.command, 500);

            expect(events.find((event) => event.type === 'native.warning')?.message).toContain(
                'exited before completing task',
            );
            expect(events.filter((event) => event.type === 'task.completed').at(-1)?.nativeSidecarStatus).toBe('mock');
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
});

type SidecarFixture = {
    readonly root: string;
    readonly command: string;
};

async function createSidecarFixture(lines: readonly string[]): Promise<SidecarFixture> {
    const root = await mkdtemp(join(tmpdir(), 'mission-control-sidecar-timeout-fixture-'));
    const command = join(root, 'sidecar.sh');
    await writeFile(command, lines.join('\n'));
    await chmod(command, 0o755);
    return { root, command };
}

async function runDemoWithSidecar(command: string, sidecarTimeoutMs: number): Promise<readonly AgentEvent[]> {
    const runtime = new AgentRuntime({
        useNative: true,
        sidecarCommand: command,
        sidecarTimeoutMs,
        permissionDecisionResolver: createAllowPermissionDecision,
    });
    const events: AgentEvent[] = [];
    runtime.onEvent((event) => {
        events.push(event);
    });

    await runtime.start();
    await runtime.runDemoTask();
    await runtime.stop();
    return events;
}
