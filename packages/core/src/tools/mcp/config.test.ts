import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    loadResolvedMcpConfig,
    readProjectScopeServers,
    readUserScopeServers,
    removeProjectMcpServer,
    removeUserMcpServer,
    writeProjectMcpServer,
    writeUserMcpServer,
} from './config.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ref = (name: string): string => `\${${name}}`;

type TempDirs = { readonly root: string; readonly userConfigPath: string; readonly projectConfigPath: string };

async function makeTempDirs(): Promise<TempDirs> {
    const root = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const userConfigPath = join(root, 'user', 'config.json');
    const projectConfigPath = join(root, 'workspace', '.mcp.json');
    return { root, userConfigPath, projectConfigPath };
}

async function writeRaw(path: string, contents: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents, 'utf8');
}

describe('loadResolvedMcpConfig merge rule', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('merges global and project servers; project wins on name collision', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp: {
                    shared: { type: 'local', command: ['from-user'] },
                    onlyUser: { type: 'local', command: ['user-bin'] },
                },
            }),
        );
        await writeRaw(
            dirs.projectConfigPath,
            JSON.stringify({
                mcpServers: {
                    shared: { type: 'local', command: ['from-project'] },
                    onlyProject: { type: 'remote', url: 'https://example.test/mcp' },
                },
            }),
        );

        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });

        const byName = new Map(resolved.servers.map((server) => [server.name, server]));
        expect(byName.size).toBe(3);
        const shared = byName.get('shared');
        expect(shared?.scope).toBe('project');
        if (shared?.type === 'local') {
            expect(shared.command).toEqual(['from-project']);
        }
        expect(byName.get('onlyUser')?.scope).toBe('user');
        expect(byName.get('onlyProject')?.scope).toBe('project');
        expect(resolved.errors).toEqual([]);
    });

    it('loads when only one scope is present', async () => {
        await writeRaw(dirs.userConfigPath, JSON.stringify({ mcp: { solo: { type: 'local', command: ['bin'] } } }));
        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });
        expect(resolved.servers.map((server) => server.name)).toEqual(['solo']);
        expect(resolved.errors).toEqual([]);
    });
});

describe('loadResolvedMcpConfig env expansion allowlist', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('expands allowlisted vars and collects the expanded value as a secret', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp: {
                    srv: {
                        type: 'local',
                        command: ['npx', ref('ALLOWED_TOOL')],
                        environment: { TOKEN: ref('ALLOWED_TOKEN') },
                    },
                },
                mcp_env_allowlist: ['ALLOWED_TOOL', 'ALLOWED_TOKEN'],
            }),
        );
        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: { ALLOWED_TOOL: 'fs-mcp', ALLOWED_TOKEN: 'super-secret-value' },
        });
        const server = resolved.servers[0];
        expect(server?.type).toBe('local');
        if (server?.type === 'local') {
            expect(server.command).toEqual(['npx', 'fs-mcp']);
            expect(server.environment).toEqual({ TOKEN: 'super-secret-value' });
        }
        expect(resolved.expandedSecrets).toContain('fs-mcp');
        expect(resolved.expandedSecrets).toContain('super-secret-value');
    });

    it('leaves a non-allowlisted secret ref unexpanded and never emits its value', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp: {
                    srv: {
                        type: 'local',
                        command: [ref('SECRET')],
                        environment: { KEY: `literal-${ref('SECRET')}-suffix` },
                    },
                },
                mcp_env_allowlist: [],
            }),
        );
        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: { SECRET: 'the-real-secret' },
        });
        const server = resolved.servers[0];
        if (server?.type === 'local') {
            expect(server.command).toEqual([ref('SECRET')]);
            expect(server.environment).toEqual({ KEY: `literal-${ref('SECRET')}-suffix` });
        }
        expect(resolved.expandedSecrets).not.toContain('the-real-secret');
        const serialized = JSON.stringify(resolved);
        expect(serialized).not.toContain('the-real-secret');
    });

    it('does not let a project allowlist extend expansion (user-only rule)', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp: { srv: { type: 'local', command: [ref('PROJECT_VAR')] } },
                mcp_env_allowlist: [],
            }),
        );
        await writeRaw(
            dirs.projectConfigPath,
            JSON.stringify({ mcpServers: { extra: { type: 'local', command: [ref('PROJECT_VAR')] } } }),
        );
        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: { PROJECT_VAR: 'expanded-by-project' },
        });
        for (const server of resolved.servers) {
            if (server.type === 'local') {
                expect(server.command).toEqual([ref('PROJECT_VAR')]);
            }
        }
        expect(resolved.expandedSecrets).not.toContain('expanded-by-project');
    });
});

describe('loadResolvedMcpConfig malformed handling', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('surfaces a clear parse error for malformed .mcp.json without crashing', async () => {
        await writeRaw(dirs.projectConfigPath, '{ not valid json');
        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });
        expect(resolved.servers).toEqual([]);
        expect(resolved.errors.length).toBe(1);
        expect(resolved.errors[0]?.source).toBe(dirs.projectConfigPath);
        expect(resolved.errors[0]?.message).toContain('parse');
    });

    it('surfaces a schema validation error for a structurally invalid entry', async () => {
        await writeRaw(dirs.userConfigPath, JSON.stringify({ mcp: { bad: { type: 'remote', url: 'not-a-url' } } }));
        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });
        expect(resolved.servers).toEqual([]);
        expect(resolved.errors.length).toBe(1);
        expect(resolved.errors[0]?.source).toBe(dirs.userConfigPath);
        expect(resolved.errors[0]?.message).toContain('validation failed');
    });
});

describe('mcp config write/read round-trips', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('writes a user server atomically and reads it back, preserving the allowlist', async () => {
        await writeRaw(dirs.userConfigPath, JSON.stringify({ mcp_env_allowlist: ['KEEP_ME'] }));
        await writeUserMcpServer(
            'srv',
            { type: 'local', command: ['npx', 'fs-mcp'] },
            {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            },
        );
        const onDisk = JSON.parse(await readFile(dirs.userConfigPath, 'utf8'));
        expect(onDisk.mcp.srv.command).toEqual(['npx', 'fs-mcp']);
        expect(onDisk.mcp_env_allowlist).toEqual(['KEEP_ME']);
        const scope = await readUserScopeServers({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        const serverName = 'srv';
        expect(scope.servers[serverName]?.type).toBe('local');
        expect(scope.allowlist).toEqual(['KEEP_ME']);
    });

    it('writes a project server atomically and reads it back', async () => {
        await writeProjectMcpServer(
            'web',
            { type: 'remote', url: 'https://example.test/mcp' },
            {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            },
        );
        const onDisk = JSON.parse(await readFile(dirs.projectConfigPath, 'utf8'));
        expect(onDisk.mcpServers.web.url).toBe('https://example.test/mcp');
        const scope = await readProjectScopeServers({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        const serverName = 'web';
        expect(scope.servers[serverName]?.type).toBe('remote');
    });

    it('removes a user server and reports false when absent', async () => {
        await writeUserMcpServer(
            'srv',
            { type: 'local', command: ['x'] },
            {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            },
        );
        const removed = await removeUserMcpServer('srv', {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(removed).toBe(true);
        const again = await removeUserMcpServer('srv', {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(again).toBe(false);
    });

    it('removes a project server and reports false when absent', async () => {
        await writeProjectMcpServer(
            'web',
            { type: 'remote', url: 'https://example.test/mcp' },
            {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            },
        );
        const removed = await removeProjectMcpServer('web', {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(removed).toBe(true);
        const again = await removeProjectMcpServer('web', {
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(again).toBe(false);
    });
});
