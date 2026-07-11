import { localSessionDbPath, missionControlDataDirEnvKey, readLocalSessionReplay } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CliArgs, type CliMode, parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { createRunEventRecorder } from './run-agent-session.js';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('createRunEventRecorder lazy session creation', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('(a) lazy TUI construction creates no session id/store and no on-disk session artifact', async () => {
        const dataDir = await useTempDataDir();

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'tui' }));

        expect(recorder.currentSessionId()).toBeUndefined();
        expect(recorder.currentStore()).toBeUndefined();
        await expect(readdir(join(dataDir, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
        await recorder.close();
    });

    it('(b) ensureSession materializes and returns a sessionId and open SQLite-backed store', async () => {
        await useTempDataDir();

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'tui' }));
        try {
            const result = await recorder.ensureSession();

            expect(result.sessionId).toEqual(expect.any(String));
            expect(result.store.sessionId).toBe(result.sessionId);
            await expect(access(localSessionDbPath())).resolves.toBeUndefined();
            expect(recorder.currentSessionId()).toBe(result.sessionId);
            expect(recorder.currentStore()).toBe(result.store);
        } finally {
            await recorder.close();
        }
    });

    it('(c) second ensureSession is idempotent (=== store, no lockExists throw)', async () => {
        await useTempDataDir();

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'tui' }));
        try {
            const first = await recorder.ensureSession();
            const second = await recorder.ensureSession();

            expect(second.store).toBe(first.store);
            expect(second.sessionId).toBe(first.sessionId);
        } finally {
            await recorder.close();
        }
    });

    it('(d) ensureSession durable order: session.started then session.metadata.updated', async () => {
        const dataDir = await useTempDataDir();
        const workspace = await makeTempDir('lazy-workspace-');

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'tui' }), {
            workspaceRoot: workspace,
        });
        let sessionId = '';
        try {
            const result = await recorder.ensureSession();
            sessionId = result.sessionId;
        } finally {
            await recorder.close();
        }

        const eventTypes = await readSessionEventTypes(sessionId);
        expect(eventTypes[0]).toBe('session.started');
        expect(eventTypes[1]).toBe('session.metadata.updated');
        await expect(readdir(join(dataDir, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('(e) non-lazy jsonl run still opens the SQLite-backed store eagerly at construction', async () => {
        const dataDir = await useTempDataDir();

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'jsonl' }));
        try {
            expect(recorder.currentSessionId()).toEqual(expect.any(String));
            expect(recorder.currentStore()?.sessionId).toBe(recorder.currentSessionId());
            await expect(access(localSessionDbPath(dataDir))).resolves.toBeUndefined();
        } finally {
            await recorder.close();
        }

        const sessionId = recorder.currentSessionId();
        expect(sessionId).toEqual(expect.any(String));
        await expect(readdir(join(dataDir, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('(f) explicit --session in TUI mode still opens eagerly', async () => {
        const dataDir = await useTempDataDir();
        const explicitId = 'session_explicit_tui';

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'tui', sessionId: explicitId }));
        try {
            expect(recorder.currentSessionId()).toBe(explicitId);
            expect(recorder.currentStore()?.sessionId).toBe(explicitId);
            await expect(access(localSessionDbPath(dataDir))).resolves.toBeUndefined();
        } finally {
            await recorder.close();
        }

        await expect(readdir(join(dataDir, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('(g) explicit local/local-echo --session prompts resume without duplicate owner prompt id or failed partial append', async () => {
        await useTempDataDir();
        const sessionId = 'session_explicit_owner_resume';

        await runAgent(
            parseArgs([
                '--no-tui',
                '--no-native',
                '--provider',
                'local',
                '--model',
                'local-echo',
                '--session',
                sessionId,
                'create a short explicit session',
            ]),
        );
        const secondOutput = await runAgent(
            parseArgs([
                '--no-tui',
                '--no-native',
                '--provider',
                'local',
                '--model',
                'local-echo',
                '--session',
                sessionId,
                'resume the explicit session with a second prompt',
            ]),
        );
        const afterSecondPrompt = await readSessionEvents(sessionId);

        expect(secondOutput).not.toContain('has already been promoted');
        const promotedInputs = afterSecondPrompt
            .filter((event) => event.type === 'prompt.promoted')
            .map((event) => event.transcript?.inputId)
            .filter((inputId): inputId is string => inputId !== undefined);
        expect(promotedInputs.length).toBeGreaterThanOrEqual(2);
        expect(new Set(promotedInputs).size).toBe(promotedInputs.length);
        expect(afterSecondPrompt.map((event) => event.message).join('\n')).toContain(
            'resume the explicit session with a second prompt',
        );
    });

    async function useTempDataDir(): Promise<string> {
        const dir = await makeTempDir('lazy-recorder-data-');
        vi.stubEnv(missionControlDataDirEnvKey, dir);
        return dir;
    }

    async function makeTempDir(prefix: string): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), prefix));
        tempDirs.push(dir);
        return dir;
    }
});

function makeArgs(overrides: { readonly mode?: CliMode; readonly sessionId?: string }): CliArgs {
    return {
        mode: overrides.mode ?? 'tui',
        useNative: undefined,
        command: 'run',
        showHelp: false,
        showVersion: false,
        thinking: false,
        ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    };
}

async function readSessionEventTypes(sessionId: string): Promise<readonly string[]> {
    return (await readSessionEvents(sessionId)).map((event) => event.type);
}

async function readSessionEvents(sessionId: string): Promise<readonly AgentEvent[]> {
    const replay = await readLocalSessionReplay({ sessionId });
    if (replay.kind !== 'found') {
        throw new Error(`expected SQLite replay for ${sessionId}`);
    }
    return replay.replay.projection.events;
}
