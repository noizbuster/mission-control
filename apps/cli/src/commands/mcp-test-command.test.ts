import { ProjectTrustStore } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runMcpCommand } from './mcp';
import { FIXTURE_SERVER, makeTempDirs, type TempDirs, writeRaw } from './mcp-command-test-support';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('mcp test', () => {
    let dirs: TempDirs;
    beforeEach(async () => {
        dirs = await makeTempDirs();
        vi.stubEnv('MCTRL_DATA_DIR', join(dirs.root, 'data'));
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('connects to the stdio fixture and lists its tool names', async () => {
        await addFixtureServer('fixtures');
        const output = await runMcpCommand(parseArgs(['mcp', 'test', 'fixtures']), paths());
        expect(output).toContain('MCP server fixtures (3 tools)');
        expect(output).toContain('echo');
        expect(output).toContain('greet');
        expect(output).toContain('fail');
    });

    it('reports a bounded failure for a crashing server', async () => {
        await addFixtureServer('crash', 'crash');
        expect(await runMcpCommand(parseArgs(['mcp', 'test', 'crash']), paths())).toContain('test failed');
    }, 15000);

    it('redacts configured secrets echoed in listed tool metadata', async () => {
        const secret = ['mcp', 'metadata', 'credential'].join('_');
        await runMcpCommand(
            parseArgs([
                'mcp',
                'add',
                'metadata',
                '--type',
                'local',
                '--command',
                'node',
                '--command',
                FIXTURE_SERVER,
                '--command',
                'metadata-secret',
                '--env',
                `MCP_TEST_SECRET=${secret}`,
                '--scope',
                'project',
            ]),
            paths(),
        );
        await trustWorkspace();
        const output = await runMcpCommand(parseArgs(['mcp', 'test', 'metadata']), paths());
        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain(secret);
    });

    it('does not spawn an undecided project server command', async () => {
        // Given
        const marker = join(dirs.root, 'project-command-spawned');
        const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`;
        await writeRaw(
            dirs.projectConfigPath,
            JSON.stringify({
                mcpServers: {
                    malicious: { type: 'local', command: [process.execPath, '--eval', source] },
                },
            }),
        );

        // When
        const output = await runMcpCommand(parseArgs(['mcp', 'test', 'malicious']), paths());

        // Then
        expect(output).toBe('MCP server malicious is not configured\n');
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('tests a user-scope server without requiring workspace trust', async () => {
        // Given
        await mkdir(dirname(dirs.projectConfigPath), { recursive: true });
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp: {
                    user_fixture: { type: 'local', command: [process.execPath, FIXTURE_SERVER, 'normal'] },
                },
            }),
        );

        // When
        const output = await runMcpCommand(parseArgs(['mcp', 'test', 'user_fixture']), paths());

        // Then
        expect(output).toContain('MCP server user_fixture (3 tools)');
    });

    it('launches from MCTRL_WORKSPACE when command options omit workspaceRoot', async () => {
        // Given
        const workspaceRoot = dirname(dirs.projectConfigPath);
        const relativeServerPath = 'selected-workspace-fixture.mjs';
        vi.stubEnv('MCTRL_WORKSPACE', workspaceRoot);
        await mkdir(workspaceRoot, { recursive: true });
        await writeFile(
            join(workspaceRoot, relativeServerPath),
            `import ${JSON.stringify(pathToFileURL(FIXTURE_SERVER).href)};\n`,
            'utf8',
        );
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp: {
                    selected_cwd: {
                        type: 'local',
                        command: [process.execPath, relativeServerPath, 'normal'],
                    },
                },
            }),
        );

        // When
        const output = await runMcpCommand(parseArgs(['mcp', 'test', 'selected_cwd']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });

        // Then
        expect(output).toContain('MCP server selected_cwd (3 tools)');
    });

    async function addFixtureServer(name: string, mode?: string): Promise<void> {
        await runMcpCommand(
            parseArgs([
                'mcp',
                'add',
                name,
                '--type',
                'local',
                '--command',
                'node',
                '--command',
                FIXTURE_SERVER,
                ...(mode === undefined ? [] : ['--command', mode]),
                '--scope',
                'project',
            ]),
            paths(),
        );
        await trustWorkspace();
    }

    async function trustWorkspace(): Promise<void> {
        await new ProjectTrustStore({ dataDir: join(dirs.root, 'data') }).setDecision(
            dirname(dirs.projectConfigPath),
            'trusted',
        );
    }

    function paths(): {
        readonly workspaceRoot: string;
        readonly userConfigPath: string;
        readonly projectConfigPath: string;
    } {
        return {
            workspaceRoot: dirname(dirs.projectConfigPath),
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        };
    }
});
