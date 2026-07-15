import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { runMcpCommand } from './mcp.js';
import { envRef, FIXTURE_SERVER, makeTempDirs, type TempDirs, writeRaw } from './mcp-command-test-support.js';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('mcp profile', () => {
    let dirs: TempDirs;
    beforeEach(async () => {
        dirs = await makeTempDirs();
    });
    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    const options = (): { readonly userConfigDir: string; readonly projectConfigPath: string } => ({
        userConfigDir: join(dirs.root, 'user'),
        projectConfigPath: dirs.projectConfigPath,
    });

    it('reads the selected profile config only', async () => {
        await writeRaw(
            join(dirs.root, 'user', 'mission-control.dev.jsonc'),
            JSON.stringify({ mcp: { devserver: { type: 'local', command: ['dev-bin'] } } }),
        );
        await writeRaw(
            join(dirs.root, 'user', 'config.json'),
            JSON.stringify({ mcp: { base: { type: 'local', command: ['base-bin'] } } }),
        );
        const output = await runMcpCommand(parseArgs(['mcp', 'list', '--profile', 'dev']), options());
        expect(output).toContain('devserver [local, user]');
        expect(output).not.toContain('base-bin');
    });

    it('creates the profile file for user-scope add', async () => {
        const output = await runMcpCommand(
            parseArgs([
                'mcp',
                'add',
                'newdev',
                '--type',
                'local',
                '--command',
                'node',
                '--command',
                FIXTURE_SERVER,
                '--scope',
                'user',
                '--profile',
                'dev',
            ]),
            options(),
        );
        expect(output).toContain('Added MCP server newdev (user scope)');
        const onDisk = JSON.parse(await readFile(join(dirs.root, 'user', 'mission-control.dev.jsonc'), 'utf8'));
        expect(onDisk.mcp.newdev.command).toEqual(['node', FIXTURE_SERVER]);
    });

    it('keeps project-scope writes on .mcp.json', async () => {
        await runMcpCommand(
            parseArgs([
                'mcp',
                'add',
                'projserver',
                '--type',
                'local',
                '--command',
                'proj-bin',
                '--scope',
                'project',
                '--profile',
                'dev',
            ]),
            options(),
        );
        const project = JSON.parse(await readFile(dirs.projectConfigPath, 'utf8'));
        expect(project.mcpServers.projserver.command).toEqual(['proj-bin']);
        await expect(readFile(join(dirs.root, 'user', 'mission-control.dev.jsonc'), 'utf8')).rejects.toThrow();
    });

    it('surfaces a missing profile', async () => {
        await expect(runMcpCommand(parseArgs(['mcp', 'list', '--profile', 'missing']), options())).rejects.toThrow(
            /No config file found for profile "missing"/,
        );
    });

    it('never prints expanded secrets next to warning output', async () => {
        const tokenRef = envRef('FAKE_TOKEN');
        await writeRaw(
            join(dirs.root, 'user', 'mission-control.dev.jsonc'),
            JSON.stringify({
                mcp_env_allowlist: ['FAKE_TOKEN'],
                mcp: { 'secret-srv': { type: 'local', command: ['echo', tokenRef], environment: { TOKEN: tokenRef } } },
            }),
        );
        await writeRaw(dirs.projectConfigPath, '{ broken json');
        const output = await runMcpCommand(parseArgs(['mcp', 'list', '--profile', 'dev']), {
            ...options(),
            env: { FAKE_TOKEN: 'SUPER_SECRET_VALUE_XYZ' },
        });
        expect(output).toContain('Warning:');
        expect(output).toContain('TOKEN=***');
        expect(output).not.toContain('SUPER_SECRET_VALUE_XYZ');
    });
});
