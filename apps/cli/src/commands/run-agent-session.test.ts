import { JsonlSessionEventStore, missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliArgs, CliMode } from '../args.js';
import { createRunEventRecorder } from './run-agent-session.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

    it('(b) ensureSession materializes and returns a sessionId and open store', async () => {
        await useTempDataDir();

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'tui' }));
        try {
            const result = await recorder.ensureSession();

            expect(result.sessionId).toEqual(expect.any(String));
            expect(result.store).toBeInstanceOf(JsonlSessionEventStore);
            expect(result.store.sessionId).toBe(result.sessionId);
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

        const eventTypes = await readSessionEventTypes(dataDir, sessionId);
        expect(eventTypes[0]).toBe('session.started');
        expect(eventTypes[1]).toBe('session.metadata.updated');
    });

    it('(e) non-lazy jsonl run still opens eagerly at construction (regression guard)', async () => {
        const dataDir = await useTempDataDir();

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'jsonl' }));
        try {
            expect(recorder.currentSessionId()).toEqual(expect.any(String));
            expect(recorder.currentStore()).toBeInstanceOf(JsonlSessionEventStore);
        } finally {
            await recorder.close();
        }

        const sessionId = recorder.currentSessionId();
        expect(sessionId).toEqual(expect.any(String));
        const files = await readdir(join(dataDir, 'sessions'));
        expect(files).toContain(`${sessionId}.jsonl`);
    });

    it('(f) explicit --session in TUI mode still opens eagerly', async () => {
        const dataDir = await useTempDataDir();
        const explicitId = 'session_explicit_tui';

        const recorder = await createRunEventRecorder(makeArgs({ mode: 'tui', sessionId: explicitId }));
        try {
            expect(recorder.currentSessionId()).toBe(explicitId);
            expect(recorder.currentStore()).toBeInstanceOf(JsonlSessionEventStore);
        } finally {
            await recorder.close();
        }

        const files = await readdir(join(dataDir, 'sessions'));
        expect(files).toContain(`${explicitId}.jsonl`);
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
        ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    };
}

async function readSessionEventTypes(dataDir: string, sessionId: string): Promise<string[]> {
    const contents = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
    return contents
        .trim()
        .split('\n')
        .map(
            (line) =>
                JSON.parse(line) as {
                    readonly kind?: string;
                    readonly event?: { readonly event?: { readonly type?: string } };
                },
        )
        .filter((record) => record.kind === 'mission-control.session-event')
        .map((record) => record.event?.event?.type ?? '');
}
