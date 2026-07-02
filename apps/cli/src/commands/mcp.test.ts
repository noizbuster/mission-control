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

describe('mcp profile', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    // Profile resolution enumerates a directory; an explicit file path (userConfigPath) conflicts
    // with profileName per T2, so profile tests pass the directory instead.
    const profileOptions = (): { readonly userConfigDir: string; readonly projectConfigPath: string } => ({
        userConfigDir: join(dirs.root, 'user'),
        projectConfigPath: dirs.projectConfigPath,
    });

    it('mcp list --profile dev reads the profile config only', async () => {
        await writeRaw(
            join(dirs.root, 'user', 'mission-control.dev.jsonc'),
            JSON.stringify({
                mcp: { devserver: { type: 'local', command: ['dev-bin'] } },
                mcp_env_allowlist: ['DEV_TOKEN'],
            }),
        );
        await writeRaw(
            join(dirs.root, 'user', 'config.json'),
            JSON.stringify({ mcp: { base: { type: 'local', command: ['base-bin'] } } }),
        );

        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list', '--profile', 'dev']), profileOptions());
        expect(listOutput).toContain('devserver [local, user]');
        expect(listOutput).toContain('command: dev-bin');
        expect(listOutput).not.toContain('base');
        expect(listOutput).not.toContain('base-bin');
    });

    it('mcp add --scope user --profile dev creates mission-control.dev.jsonc', async () => {
        const addOutput = await runMcpCommand(
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
            profileOptions(),
        );
        expect(addOutput).toContain('Added MCP server newdev (user scope)');

        const profilePath = join(dirs.root, 'user', 'mission-control.dev.jsonc');
        const onDisk = JSON.parse(await readFile(profilePath, 'utf8'));
        expect(onDisk.mcp.newdev.command).toEqual(['node', FIXTURE_SERVER]);

        await expect(readFile(join(dirs.root, 'user', 'config.json'), 'utf8')).rejects.toThrow();
    });

    it('mcp add --scope project --profile dev still writes .mcp.json only', async () => {
        const addOutput = await runMcpCommand(
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
            profileOptions(),
        );
        expect(addOutput).toContain('Added MCP server projserver (project scope)');

        const projectOnDisk = JSON.parse(await readFile(dirs.projectConfigPath, 'utf8'));
        expect(projectOnDisk.mcpServers.projserver.command).toEqual(['proj-bin']);

        await expect(readFile(join(dirs.root, 'user', 'mission-control.dev.jsonc'), 'utf8')).rejects.toThrow();
    });

    it('mcp list --profile missing surfaces a profile-not-found error without silent success', async () => {
        await expect(
            runMcpCommand(parseArgs(['mcp', 'list', '--profile', 'missing']), profileOptions()),
        ).rejects.toThrow(/No config file found for profile "missing"/);
    });

    it('never prints an expanded secret value in list output that includes a warning line', async () => {
        const tokenRef = ref('FAKE_TOKEN');
        await writeRaw(
            join(dirs.root, 'user', 'mission-control.dev.jsonc'),
            JSON.stringify({
                mcp_env_allowlist: ['FAKE_TOKEN'],
                mcp: { 'secret-srv': { type: 'local', command: ['echo', tokenRef], environment: { TOKEN: tokenRef } } },
            }),
        );
        // Co-locate a malformed project config so the output carries a Warning line alongside the
        // server line; this proves redaction covers the full joined text, not just the env mask.
        await writeRaw(dirs.projectConfigPath, '{ broken json');

        const listOutput = await runMcpCommand(parseArgs(['mcp', 'list', '--profile', 'dev']), {
            ...profileOptions(),
            env: { FAKE_TOKEN: 'SUPER_SECRET_VALUE_XYZ' },
        });
        expect(listOutput).toContain('Warning:');
        expect(listOutput).toContain('TOKEN=***');
        expect(listOutput).not.toContain('SUPER_SECRET_VALUE_XYZ');
    });
});
