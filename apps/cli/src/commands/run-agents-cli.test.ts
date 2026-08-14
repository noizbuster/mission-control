import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args';
import { runAgentsCommand } from './run-agents-cli';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

async function makeTempArea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'run-agents-cli-test-'));
    const workspace = join(root, 'workspace');
    const userConfig = join(root, 'user-config');
    await mkdir(workspace, { recursive: true });
    await mkdir(userConfig, { recursive: true });
    return { root, workspace, userConfig };
}

const STUBBED_ENV_KEYS = ['MCTRL_WORKSPACE', 'MCTRL_CONFIG_DIR'] as const;

describe('runAgentsCommand', () => {
    let area: TempArea;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(async () => {
        area = await makeTempArea();
        savedEnv = {};
        for (const key of STUBBED_ENV_KEYS) {
            savedEnv[key] = process.env[key];
            process.env[key] = area[key === 'MCTRL_WORKSPACE' ? 'workspace' : 'userConfig'];
        }
    });

    afterEach(async () => {
        for (const key of STUBBED_ENV_KEYS) {
            process.env[key] = savedEnv[key];
        }
        await rm(area.root, { recursive: true, force: true });
    });

    it('routes an empty argv tail to list and reports the discovered bundled agents', async () => {
        const output = await runAgentsCommand(parseArgs(['agents']));
        expect(output).toContain('Discovered agents (12)');
        expect(output).toContain('oracle');
    });

    it('routes `agents list` to the list output', async () => {
        const output = await runAgentsCommand(parseArgs(['agents', 'list']));
        expect(output).toContain('Discovered agents (12)');
    });

    it('routes `agents show <name>` to the agent detail block', async () => {
        const output = await runAgentsCommand(parseArgs(['agents', 'show', 'oracle']));
        expect(output).toContain('Agent: oracle');
    });

    it('routes an unknown subcommand to the invalid-message surface without throwing', async () => {
        const output = await runAgentsCommand(parseArgs(['agents', 'frobnicate']));
        expect(output).toContain('Unknown agents subcommand');
    });
});
