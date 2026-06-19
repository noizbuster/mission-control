import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { runMcpCommand } from './mcp.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_SERVER = join(
    process.cwd(),
    'packages',
    'core',
    'src',
    'tools',
    'mcp',
    'fixtures',
    'stdio-fixture-server.mjs',
);

const ref = (name: string): string => `\${${name}}`;

type TempDirs = { readonly root: string; readonly userConfigPath: string; readonly projectConfigPath: string };

async function makeTempDirs(): Promise<TempDirs> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-mcp-'));
    return {
        root,
        userConfigPath: join(root, 'user', 'config.json'),
        projectConfigPath: join(root, 'workspace', '.mcp.json'),
    };
}

async function writeRaw(path: string, contents: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents, 'utf8');
}

describe('mcp add then list', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('adds a local server via parsed args and lists it', async () => {
        const addArgs = parseArgs([
            'mcp',
            'add',
            'fixtures',
            '--type',
            'local',
            '--command',
            'node',
            '--command',
            FIXTURE_SERVER,
            '--scope',
            'project',
        ]);
        const addOutput = await runMcpCommand(addArgs, {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(addOutput).toContain('Added MCP server fixtures (project scope)');

        const listArgs = parseArgs(['mcp', 'list']);
        const listOutput = await runMcpCommand(listArgs, {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(listOutput).toContain('fixtures [local, project]');
        expect(listOutput).toContain('command: node');
    });

    it('adds a remote server and lists the url with masked headers', async () => {
        const addArgs = parseArgs([
            'mcp',
            'add',
            'web',
            '--type',
            'remote',
            '--url',
            'https://example.test/mcp',
            '--header',
            'Authorization=Bearer-literal-secret',
            '--scope',
            'user',
        ]);
        await runMcpCommand(addArgs, {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });

        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(listOutput).toContain('web [remote, user]');
        expect(listOutput).toContain('url: https://example.test/mcp');
        expect(listOutput).toContain('Authorization=***');
        expect(listOutput).not.toContain('Bearer-literal-secret');
    });
});

describe('mcp list masking', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('never prints a raw literal secret env value; shows KEY=*** instead', async () => {
        const addArgs = parseArgs([
            'mcp',
            'add',
            'secret-srv',
            '--type',
            'local',
            '--command',
            'node',
            '--command',
            FIXTURE_SERVER,
            '--env',
            'API_KEY=super-secret-value-xyz',
            '--scope',
            'project',
        ]);
        await runMcpCommand(addArgs, {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });

        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(listOutput).toContain('API_KEY=***');
        expect(listOutput).not.toContain('super-secret-value-xyz');
    });

    it('expands an allowlisted env var for the client but masks it in list output', async () => {
        await writeRaw(dirs.userConfigPath, JSON.stringify({ mcp_env_allowlist: ['ALLOWED_TOKEN'] }));
        const addArgs = parseArgs([
            'mcp',
            'add',
            'expanded',
            '--type',
            'local',
            '--command',
            'node',
            '--command',
            FIXTURE_SERVER,
            '--env',
            `TOKEN=${ref('ALLOWED_TOKEN')}`,
            '--scope',
            'user',
        ]);
        await runMcpCommand(addArgs, {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });

        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: { ALLOWED_TOKEN: 'expanded-secret-999' },
        });
        expect(listOutput).toContain('TOKEN=***');
        expect(listOutput).not.toContain('expanded-secret-999');
    });
});

describe('mcp remove', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('removes a configured server and reports absent ones', async () => {
        await runMcpCommand(
            parseArgs(['mcp', 'add', 'gone', '--type', 'local', '--command', 'x', '--scope', 'project']),
            { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
        );
        const removed = await runMcpCommand(parseArgs(['mcp', 'remove', 'gone', '--scope', 'project']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(removed).toContain('Removed MCP server gone');
        const absent = await runMcpCommand(parseArgs(['mcp', 'remove', 'gone', '--scope', 'project']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(absent).toContain('not configured');
    });
});

describe('mcp test', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('connects to the stdio fixture and lists its tool names', async () => {
        await runMcpCommand(
            parseArgs([
                'mcp',
                'add',
                'fixtures',
                '--type',
                'local',
                '--command',
                'node',
                '--command',
                FIXTURE_SERVER,
                '--scope',
                'project',
            ]),
            { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
        );

        const testOutput = await runMcpCommand(parseArgs(['mcp', 'test', 'fixtures']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(testOutput).toContain('MCP server fixtures (3 tools)');
        expect(testOutput).toContain('echo');
        expect(testOutput).toContain('greet');
        expect(testOutput).toContain('fail');
    });

    it('reports a bounded failure for a crashing server (no hang)', async () => {
        await runMcpCommand(
            parseArgs([
                'mcp',
                'add',
                'crash',
                '--type',
                'local',
                '--command',
                'node',
                '--command',
                FIXTURE_SERVER,
                '--command',
                'crash',
                '--scope',
                'project',
            ]),
            { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
        );

        const testOutput = await runMcpCommand(parseArgs(['mcp', 'test', 'crash']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(testOutput).toContain('test failed');
    }, 15000);
});

describe('mcp list malformed handling', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('renders a clear warning for a malformed .mcp.json without crashing', async () => {
        await writeRaw(dirs.projectConfigPath, '{ broken json');
        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list']), {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(listOutput).toContain('Warning:');
        expect(listOutput).toContain('parse');
    });

    it('preserves prior user config when adding to project scope', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({ mcp: { keep: { type: 'local', command: ['keep-bin'] } } }),
        );
        await runMcpCommand(
            parseArgs(['mcp', 'add', 'new', '--type', 'local', '--command', 'new-bin', '--scope', 'project']),
            { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
        );
        const userOnDisk = JSON.parse(await readFile(dirs.userConfigPath, 'utf8'));
        expect(userOnDisk.mcp.keep.command).toEqual(['keep-bin']);
        const projectOnDisk = JSON.parse(await readFile(dirs.projectConfigPath, 'utf8'));
        expect(projectOnDisk.mcpServers.new.command).toEqual(['new-bin']);
    });
});
