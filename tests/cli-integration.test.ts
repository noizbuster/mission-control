import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../apps/cli/src/args.js';
import { createProviderAuthStore } from '../apps/cli/src/auth-store.js';
import { runAuthCommand } from '../apps/cli/src/commands/auth.js';
import { runAgent } from '../apps/cli/src/commands/run-agent.js';
import { missionControlAuthFileEnvKey } from '../packages/config/src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-cli-integration-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

describe('CLI integration', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('emits the plain mode demo report', async () => {
        const output = await runAgent(parseArgs(['--no-tui']));

        expect(output).toContain('mission-control');
        expect(output).toContain('mctrl');
        expect(output).toContain('task.completed');
    });

    it('emits JSON Lines demo events', async () => {
        const output = await runAgent(parseArgs(['--json']));
        const lines = output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { readonly type?: string });

        expect(lines.some((line) => line.type === 'session.started')).toBe(true);
        expect(lines.some((line) => line.type === 'task.completed')).toBe(true);
    });

    it('emits selected provider and model through CLI integration', async () => {
        const output = await runAgent(parseArgs(['--no-tui', '--provider', 'local', '--model', 'local-echo']));

        expect(output).toContain('model: local/local-echo');
        expect(output).toContain('task.completed');
    });

    it('uses auth configured provider defaults through CLI integration', async () => {
        const authFilePath = await useTempAuthFile();
        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store: createProviderAuthStore(),
        });

        const output = await runAgent(parseArgs(['--no-tui']));

        expect(output).toContain('model: local/local-echo');
        await rm(authFilePath, { force: true });
    });

    it('uses auth configured OpenCode provider defaults through CLI integration', async () => {
        const authFilePath = await useTempAuthFile();
        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store: createProviderAuthStore(),
        });

        const output = await runAgent(parseArgs(['--no-tui']));

        expect(output).toContain('model: anthropic/claude-3-5-haiku-20241022');
        expect(output).toContain('task.completed');
        expect(output).not.toContain('anthropic_key');
        await rm(authFilePath, { force: true });
    });
});
