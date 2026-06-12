import { describe, expect, it } from 'vitest';
import { normalizeSidecarLine, ProcessSidecarClient } from './sidecar-client.js';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sidecar response normalization', () => {
    it('normalizes sidecar JSONL responses to protocol events', () => {
        const handshake = normalizeSidecarLine(
            '{"type":"handshake_completed","id":"handshake_1","protocolVersion":1,"capabilities":["task.run"]}',
            'session_1',
        );
        const progress = normalizeSidecarLine('{"type":"task_progress","id":"task_1","progress":0.25}', 'session_1');
        const completed = normalizeSidecarLine(
            '{"type":"task_completed","id":"task_1","result":{"message":"completed by rust sidecar"}}',
            'session_1',
        );

        expect(handshake).toMatchObject({
            type: 'native.status',
            sessionId: 'session_1',
            taskId: 'handshake_1',
            nativeSidecarStatus: 'native',
        });
        expect(progress).toMatchObject({
            type: 'task.progress',
            sessionId: 'session_1',
            taskId: 'task_1',
            progress: 0.25,
        });
        expect(completed).toMatchObject({
            type: 'task.completed',
            sessionId: 'session_1',
            taskId: 'task_1',
            message: 'completed by rust sidecar',
        });
    });

    it('normalizes sidecar failure and cancellation responses to failed task events', () => {
        const failed = normalizeSidecarLine(
            '{"type":"task_failed","id":"task_1","error":{"code":"sidecar_failed","message":"provider process exited","retryable":false}}',
            'session_1',
        );
        const cancelled = normalizeSidecarLine(
            '{"type":"task_cancelled","id":"task_1","reason":"user stopped task"}',
            'session_1',
        );

        expect(failed).toMatchObject({
            type: 'task.failed',
            sessionId: 'session_1',
            taskId: 'task_1',
            message: 'sidecar_failed: provider process exited',
        });
        expect(cancelled).toMatchObject({
            type: 'task.failed',
            sessionId: 'session_1',
            taskId: 'task_1',
            message: 'sidecar task cancelled: user stopped task',
        });
    });

    it('negotiates v2 cancel capability only when enabled', async () => {
        const fixture = await createV2SidecarFixture();
        const v1Client = new ProcessSidecarClient(fixture.command, 250);
        const v2Client = new ProcessSidecarClient(fixture.command, 250, { enableProtocolV2: true });

        try {
            await expect(v1Client.runTask({ id: 'task_1', payload: { label: 'demo' } })).rejects.toThrow(
                'sidecar protocol version mismatch',
            );
            await v1Client.stop();

            const output = await v2Client.runTask({ id: 'task_2', payload: { label: 'demo' } });

            expect(output.message).toBe('completed by v2 fixture sidecar');
            expect(v2Client.capabilities()).toEqual(['task.run', 'task.cancel']);
        } finally {
            await v1Client.stop();
            await v2Client.stop();
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
});

type SidecarFixture = {
    readonly root: string;
    readonly command: string;
};

async function createV2SidecarFixture(): Promise<SidecarFixture> {
    const root = await mkdtemp(join(tmpdir(), 'mission-control-sidecar-v2-fixture-'));
    const command = join(root, 'sidecar.sh');
    await writeFile(
        command,
        [
            '#!/usr/bin/env sh',
            'while IFS= read -r line; do',
            '  case "$line" in',
            '    *\\"type\\":\\"handshake\\"*)',
            '      echo \'{"type":"handshake_completed","id":"handshake_fixture","protocolVersion":2,"capabilities":["task.run","task.cancel"]}\'',
            '      ;;',
            '    *\\"type\\":\\"run_task\\"*)',
            '      echo \'{"type":"task_completed","id":"task_2","result":{"message":"completed by v2 fixture sidecar"}}\'',
            '      ;;',
            '  esac',
            'done',
            '',
        ].join('\n'),
    );
    await chmod(command, 0o755);
    return { root, command };
}
