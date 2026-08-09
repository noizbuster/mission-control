// allow: SIZE_OK -- HEAD 747 -> current 1042 pure LOC; one MCP configuration resolution and atomic write boundary integration matrix.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    loadResolvedMcpConfig,
    ProfileNameValidationError,
    readProjectScopeServers,
    readUserScopeServers,
    removeProjectMcpServer,
    removeUserMcpServer,
    resolveUserConfigPath,
    resolveUserProfileCandidates,
    validateProfileName,
    writeProjectMcpServer,
    writeUserMcpServer,
} from './config';
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

    it('returns the typed gated-tool snapshot from the base config', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                memory: { backend: 'local' },
                team_mode: {},
                monitor: {},
                ssh: { hosts: [{ name: 'staging', host: 'staging.example.test' }] },
                debug: {},
            }),
        );

        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });

        expect(resolved.config.memory?.backend).toBe('local');
        expect(resolved.config.team_mode?.enabled).toBe(false);
        expect(resolved.config.monitor?.enabled).toBe(false);
        expect(resolved.config.ssh?.hosts).toEqual([{ name: 'staging', host: 'staging.example.test' }]);
        expect(resolved.config.debug?.enabled).toBe(false);
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

    it('collects literal environment and header values as secrets', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                mcp: {
                    local: {
                        type: 'local',
                        command: ['local-mcp'],
                        environment: { API_TOKEN: 'literal-local-secret' },
                    },
                    remote: {
                        type: 'remote',
                        url: 'https://mcp.example.test',
                        headers: { Authorization: 'Bearer literal-remote-secret' },
                    },
                },
            }),
        );

        const resolved = await loadResolvedMcpConfig({
            userConfigPath: dirs.userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });

        expect(resolved.expandedSecrets).toContain('literal-local-secret');
        expect(resolved.expandedSecrets).toContain('Bearer literal-remote-secret');
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

    it('preserves every validated user field when adding a server', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                browser: { browserURL: 'http://127.0.0.1:9222' },
                lsp: { command: ['rust-analyzer'], environment: { RUST_LOG: 'debug' }, timeoutMs: 1200 },
                mcp_env_allowlist: ['KEEP_ME'],
                mcp: { existing: { type: 'local', command: ['existing-mcp'] } },
            }),
        );

        await writeUserMcpServer(
            'added',
            { type: 'local', command: ['added-mcp'] },
            { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
        );

        const onDisk = JSON.parse(await readFile(dirs.userConfigPath, 'utf8'));
        expect(onDisk).toEqual({
            browser: { browserURL: 'http://127.0.0.1:9222' },
            lsp: { command: ['rust-analyzer'], environment: { RUST_LOG: 'debug' }, timeoutMs: 1200 },
            mcp_env_allowlist: ['KEEP_ME'],
            mcp: {
                existing: { type: 'local', command: ['existing-mcp'] },
                added: { type: 'local', command: ['added-mcp'] },
            },
        });
    });

    it('preserves every validated user field when removing a server', async () => {
        await writeRaw(
            dirs.userConfigPath,
            JSON.stringify({
                browser: { browserURL: 'http://127.0.0.1:9222' },
                lsp: { command: ['rust-analyzer'], environment: { RUST_LOG: 'debug' }, timeoutMs: 1200 },
                mcp_env_allowlist: ['KEEP_ME'],
                mcp: {
                    keep: { type: 'local', command: ['keep-mcp'] },
                    remove: { type: 'local', command: ['remove-mcp'] },
                },
            }),
        );

        expect(
            await removeUserMcpServer('remove', {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            }),
        ).toBe(true);

        const onDisk = JSON.parse(await readFile(dirs.userConfigPath, 'utf8'));
        expect(onDisk).toEqual({
            browser: { browserURL: 'http://127.0.0.1:9222' },
            lsp: { command: ['rust-analyzer'], environment: { RUST_LOG: 'debug' }, timeoutMs: 1200 },
            mcp_env_allowlist: ['KEEP_ME'],
            mcp: { keep: { type: 'local', command: ['keep-mcp'] } },
        });
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

    it('preserves every validated project field when adding a server', async () => {
        await writeRaw(
            dirs.projectConfigPath,
            JSON.stringify({ mcpServers: { existing: { type: 'local', command: ['existing-mcp'] } } }),
        );

        await writeProjectMcpServer(
            'added',
            { type: 'local', command: ['added-mcp'] },
            { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
        );

        const onDisk = JSON.parse(await readFile(dirs.projectConfigPath, 'utf8'));
        expect(onDisk).toEqual({
            mcpServers: {
                existing: { type: 'local', command: ['existing-mcp'] },
                added: { type: 'local', command: ['added-mcp'] },
            },
        });
    });

    it('preserves every validated project field when removing a server', async () => {
        await writeRaw(
            dirs.projectConfigPath,
            JSON.stringify({
                mcpServers: {
                    keep: { type: 'local', command: ['keep-mcp'] },
                    remove: { type: 'local', command: ['remove-mcp'] },
                },
            }),
        );

        expect(
            await removeProjectMcpServer('remove', {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            }),
        ).toBe(true);

        const onDisk = JSON.parse(await readFile(dirs.projectConfigPath, 'utf8'));
        expect(onDisk).toEqual({ mcpServers: { keep: { type: 'local', command: ['keep-mcp'] } } });
    });

    it('rejects unknown fields before user add', async () => {
        await writeRaw(dirs.userConfigPath, JSON.stringify({ unknown: true }));
        await expect(
            writeUserMcpServer(
                'srv',
                { type: 'local', command: ['x'] },
                { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
            ),
        ).rejects.toThrow(/config validation failed/);
    });

    it('rejects unknown fields before project add', async () => {
        await writeRaw(dirs.projectConfigPath, JSON.stringify({ unknown: true }));
        await expect(
            writeProjectMcpServer(
                'srv',
                { type: 'local', command: ['x'] },
                { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
            ),
        ).rejects.toThrow(/config validation failed/);
    });

    it('rejects malformed user config before remove and leaves bytes untouched', async () => {
        const contents = '{ "unknown": true }';
        await writeRaw(dirs.userConfigPath, contents);
        await expect(
            removeUserMcpServer('missing', {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            }),
        ).rejects.toThrow(/config validation failed/);
        expect(await readFile(dirs.userConfigPath, 'utf8')).toBe(contents);
    });

    it('leaves user config bytes untouched when removing an absent server', async () => {
        const contents = '{\n  "mcp": {},\n  "mcp_env_allowlist": ["KEEP_ME"]\n}\n';
        await writeRaw(dirs.userConfigPath, contents);
        await expect(
            removeUserMcpServer('missing', {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            }),
        ).resolves.toBe(false);
        expect(await readFile(dirs.userConfigPath, 'utf8')).toBe(contents);
    });

    it('leaves project config bytes untouched when removing an absent server', async () => {
        const contents = '{\n  "mcpServers": {}\n}\n';
        await writeRaw(dirs.projectConfigPath, contents);
        await expect(
            removeProjectMcpServer('missing', {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            }),
        ).resolves.toBe(false);
        expect(await readFile(dirs.projectConfigPath, 'utf8')).toBe(contents);
    });

    it('rejects malformed project config before remove and leaves bytes untouched', async () => {
        const contents = '{ "unknown": true }';
        await writeRaw(dirs.projectConfigPath, contents);
        await expect(
            removeProjectMcpServer('missing', {
                userConfigPath: dirs.userConfigPath,
                projectConfigPath: dirs.projectConfigPath,
            }),
        ).rejects.toThrow(/config validation failed/);
        expect(await readFile(dirs.projectConfigPath, 'utf8')).toBe(contents);
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

describe('validateProfileName', () => {
    it('returns undefined for undefined input so callers can spread conditionally', () => {
        expect(validateProfileName(undefined)).toBeUndefined();
    });

    it.each(['dev', 'prod', 'prod-1', 'a_b', 'a1', 'x', 'a'.repeat(64)])('accepts a valid name: %s', (name) => {
        expect(validateProfileName(name)).toBe(name);
    });

    const invalidNames: readonly string[] = [
        '',
        '.',
        '..',
        '.dev',
        'a/b',
        'a\\b',
        'Dev',
        'UPPER',
        '-lead',
        '_lead',
        'has.space',
        'a.b',
        'a'.repeat(65),
    ];
    it.each(invalidNames)('throws ProfileNameValidationError for invalid name: %s', (name) => {
        try {
            validateProfileName(name);
            throw new Error(`expected validateProfileName to throw for ${JSON.stringify(name)}`);
        } catch (error) {
            expect(error).toBeInstanceOf(ProfileNameValidationError);
            if (error instanceof ProfileNameValidationError) {
                expect(error.invalidValue).toBe(name);
                expect(error.message).toContain(JSON.stringify(name));
            }
        }
    });

    it('escapes a backslash in the offending value via JSON.stringify', () => {
        const raw = 'a\\b';
        try {
            validateProfileName(raw);
            throw new Error('expected throw');
        } catch (error) {
            expect(error).toBeInstanceOf(ProfileNameValidationError);
            if (error instanceof ProfileNameValidationError) {
                expect(error.message).toContain('"a\\\\b"');
            }
        }
    });
});

describe('resolveUserProfileCandidates', () => {
    it('returns the four candidates in fixed priority order inside the config dir', () => {
        const candidates = resolveUserProfileCandidates('dev', { userConfigDir: '/cfg', env: {} });
        expect(candidates).toEqual([
            '/cfg/mission-control.dev.jsonc',
            '/cfg/mission-control.dev.json',
            '/cfg/config.dev.jsonc',
            '/cfg/config.dev.json',
        ]);
    });

    it('throws ProfileNameValidationError for an invalid profile name (never joins unvalidated)', () => {
        expect(() => resolveUserProfileCandidates('a/b', { userConfigDir: '/cfg', env: {} })).toThrow(
            ProfileNameValidationError,
        );
    });

    it('honors userConfigDir over MCTRL_CONFIG_DIR env', () => {
        const candidates = resolveUserProfileCandidates('dev', {
            userConfigDir: '/explicit',
            env: { MCTRL_CONFIG_DIR: '/env' },
        });
        expect(candidates[0]).toBe('/explicit/mission-control.dev.jsonc');
    });

    it('uses MCTRL_CONFIG_DIR env as the dir when userConfigDir is absent', () => {
        const candidates = resolveUserProfileCandidates('dev', { env: { MCTRL_CONFIG_DIR: '/envdir' } });
        expect(candidates[0]).toBe('/envdir/mission-control.dev.jsonc');
        expect(candidates[3]).toBe('/envdir/config.dev.json');
    });
});

describe('profile path resolution', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'mcp-profile-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function touch(path: string): Promise<void> {
        await writeFile(path, '{}', 'utf8');
    }

    it('returns the first candidate when mission-control.<profile>.jsonc exists', async () => {
        await touch(join(dir, 'mission-control.dev.jsonc'));
        const resolved = resolveUserConfigPath({ profileName: 'dev', userConfigDir: dir, env: {} });
        expect(resolved).toBe(join(dir, 'mission-control.dev.jsonc'));
    });

    it('falls back to mission-control.<profile>.json when the jsonc candidate is absent', async () => {
        await touch(join(dir, 'mission-control.dev.json'));
        const resolved = resolveUserConfigPath({ profileName: 'dev', userConfigDir: dir, env: {} });
        expect(resolved).toBe(join(dir, 'mission-control.dev.json'));
    });

    it('falls back to config.<profile>.jsonc when both mission-control candidates are absent', async () => {
        await touch(join(dir, 'config.dev.jsonc'));
        const resolved = resolveUserConfigPath({ profileName: 'dev', userConfigDir: dir, env: {} });
        expect(resolved).toBe(join(dir, 'config.dev.jsonc'));
    });

    it('falls back to config.<profile>.json when only it exists', async () => {
        await touch(join(dir, 'config.dev.json'));
        const resolved = resolveUserConfigPath({ profileName: 'dev', userConfigDir: dir, env: {} });
        expect(resolved).toBe(join(dir, 'config.dev.json'));
    });

    it('prefers mission-control-prefixed names over generic config.* names', async () => {
        await touch(join(dir, 'mission-control.dev.json'));
        await touch(join(dir, 'config.dev.jsonc'));
        const resolved = resolveUserConfigPath({ profileName: 'dev', userConfigDir: dir, env: {} });
        expect(resolved).toBe(join(dir, 'mission-control.dev.json'));
    });

    it('throws profile-not-found naming the profile and listing all four tried paths when none exist', () => {
        try {
            resolveUserConfigPath({ profileName: 'dev', userConfigDir: dir, env: {} });
            throw new Error('expected resolveUserConfigPath to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('"dev"');
            expect(message).toContain(join(dir, 'mission-control.dev.jsonc'));
            expect(message).toContain(join(dir, 'mission-control.dev.json'));
            expect(message).toContain(join(dir, 'config.dev.jsonc'));
            expect(message).toContain(join(dir, 'config.dev.json'));
        }
    });

    it('throws a conflict error when userConfigPath and profileName are both set', () => {
        expect(() =>
            resolveUserConfigPath({
                profileName: 'dev',
                userConfigPath: '/explicit/config.json',
                userConfigDir: dir,
                env: {},
            }),
        ).toThrow(/Conflicting config options/);
    });

    it('throws ProfileNameValidationError for an invalid profile name before any file access', () => {
        expect(() => resolveUserConfigPath({ profileName: '../bad', userConfigDir: dir, env: {} })).toThrow(
            ProfileNameValidationError,
        );
    });

    it('honors userConfigDir as the candidate directory', async () => {
        await touch(join(dir, 'config.prod.json'));
        const resolved = resolveUserConfigPath({ profileName: 'prod', userConfigDir: dir, env: {} });
        expect(resolved).toBe(join(dir, 'config.prod.json'));
    });
});

describe('resolveUserConfigPath unprofiled backward compatibility', () => {
    it('returns <userConfigDir>/config.json when only userConfigDir is set', () => {
        expect(resolveUserConfigPath({ userConfigDir: '/cfg', env: {} })).toBe('/cfg/config.json');
    });

    it('returns userConfigPath directly when set and no profile', () => {
        expect(resolveUserConfigPath({ userConfigPath: '/explicit/config.json', env: {} })).toBe(
            '/explicit/config.json',
        );
    });

    it('returns <MCTRL_CONFIG_DIR>/config.json from env without appending the app name', () => {
        expect(resolveUserConfigPath({ env: { MCTRL_CONFIG_DIR: '/envcfg' } })).toBe('/envcfg/config.json');
    });

    it('userConfigDir takes precedence over MCTRL_CONFIG_DIR env', () => {
        expect(resolveUserConfigPath({ userConfigDir: '/cfg', env: { MCTRL_CONFIG_DIR: '/envcfg' } })).toBe(
            '/cfg/config.json',
        );
    });
});

describe('loadResolvedMcpConfig profile read', () => {
    let dirs: { readonly root: string; readonly userConfigDir: string; readonly projectConfigPath: string };

    beforeEach(async () => {
        const root = await mkdtemp(join(tmpdir(), 'mcp-prof-'));
        dirs = {
            root,
            userConfigDir: join(root, 'config'),
            projectConfigPath: join(root, 'workspace', '.mcp.json'),
        };
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('profile replaces base config: no base server leaks when a profile is selected', async () => {
        await writeRaw(
            join(dirs.userConfigDir, 'config.json'),
            JSON.stringify({ mcp: { base: { type: 'local', command: ['base-bin'] } } }),
        );
        await writeRaw(
            join(dirs.userConfigDir, 'mission-control.dev.json'),
            JSON.stringify({ mcp: { profile: { type: 'local', command: ['profile-bin'] } } }),
        );
        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });
        const names = resolved.servers.map((server) => server.name);
        expect(names).toEqual(['profile']);
        expect(names).not.toContain('base');
        expect(resolved.errors).toEqual([]);
    });

    it('throws profile-not-found listing the tried candidates when no profile file exists', async () => {
        await writeRaw(
            join(dirs.userConfigDir, 'config.json'),
            JSON.stringify({ mcp: { base: { type: 'local', command: ['base-bin'] } } }),
        );
        const dir = dirs.userConfigDir;
        try {
            await loadResolvedMcpConfig({
                profileName: 'missing',
                userConfigDir: dir,
                projectConfigPath: dirs.projectConfigPath,
                env: {},
            });
            throw new Error('expected loadResolvedMcpConfig to throw profile-not-found');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('No config file found for profile "missing"');
            expect(message).toContain(join(dir, 'mission-control.missing.jsonc'));
            expect(message).toContain(join(dir, 'mission-control.missing.json'));
            expect(message).toContain(join(dir, 'config.missing.jsonc'));
            expect(message).toContain(join(dir, 'config.missing.json'));
        }
    });

    it('strips JSONC comments (// and /* */) from .jsonc profile files before parsing', async () => {
        await writeRaw(
            join(dirs.userConfigDir, 'mission-control.dev.jsonc'),
            [
                '{',
                '  // line comment',
                '  "mcp": {',
                '    "srv": { "type": "local", "command": ["x"] } /* block comment */',
                '  }',
                '}',
            ].join('\n'),
        );
        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });
        expect(resolved.servers.map((server) => server.name)).toEqual(['srv']);
        expect(resolved.errors).toEqual([]);
    });

    it('returns the typed gated-tool snapshot from the selected JSONC profile', async () => {
        await writeRaw(
            join(dirs.userConfigDir, 'mission-control.dev.jsonc'),
            [
                '{',
                '  // gated tool families',
                '  "memory": { "backend": "local" },',
                '  "team_mode": { "enabled": true },',
                '  "monitor": { "enabled": true, "maxRuntimeMs": 60000 },',
                '  "ssh": { "hosts": [{ "name": "staging", "host": "staging.example.test" }] },',
                '  "debug": { "enabled": true }',
                '}',
            ].join('\n'),
        );

        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });

        expect(resolved.config.memory?.backend).toBe('local');
        expect(resolved.config.team_mode?.enabled).toBe(true);
        expect(resolved.config.monitor).toEqual({
            enabled: true,
            liveModeEnabled: false,
            maxMonitorsPerSession: 3,
            maxRuntimeMs: 60_000,
        });
        expect(resolved.config.ssh?.hosts).toEqual([{ name: 'staging', host: 'staging.example.test' }]);
        expect(resolved.config.debug?.enabled).toBe(true);
        expect(resolved.errors).toEqual([]);
    });

    it('rejects trailing commas with a clear parse error (no silent acceptance)', async () => {
        await writeRaw(
            join(dirs.userConfigDir, 'mission-control.dev.jsonc'),
            '{ "mcp": { "srv": { "type": "local", "command": ["x"], } } }',
        );
        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });
        expect(resolved.servers).toEqual([]);
        expect(resolved.errors.length).toBe(1);
        expect(resolved.errors[0]?.message).toContain('parse');
    });

    it('project .mcp.json still overrides profile servers by name', async () => {
        await writeRaw(
            join(dirs.userConfigDir, 'mission-control.dev.json'),
            JSON.stringify({
                mcp: {
                    shared: { type: 'local', command: ['from-profile'] },
                    onlyProfile: { type: 'local', command: ['profile-only'] },
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
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });
        const byName = new Map(resolved.servers.map((server) => [server.name, server]));
        const shared = byName.get('shared');
        expect(shared?.scope).toBe('project');
        if (shared?.type === 'local') {
            expect(shared.command).toEqual(['from-project']);
        }
        expect(byName.get('onlyProfile')?.scope).toBe('user');
        expect(byName.get('onlyProject')?.scope).toBe('project');
    });

    it('profile allowlist alone controls expansion: base config allowlist never leaks', async () => {
        await writeRaw(
            join(dirs.userConfigDir, 'config.json'),
            JSON.stringify({
                mcp: { base: { type: 'local', command: [ref('BASE_VAR')] } },
                mcp_env_allowlist: ['BASE_VAR'],
            }),
        );
        await writeRaw(
            join(dirs.userConfigDir, 'mission-control.dev.json'),
            JSON.stringify({
                mcp: {
                    prof: { type: 'local', command: [ref('PROFILE_VAR'), ref('BASE_VAR')] },
                },
                mcp_env_allowlist: ['PROFILE_VAR'],
            }),
        );
        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
            env: { BASE_VAR: 'base-expanded', PROFILE_VAR: 'profile-expanded' },
        });
        const names = resolved.servers.map((server) => server.name);
        expect(names).toEqual(['prof']);
        expect(names).not.toContain('base');
        const prof = resolved.servers[0];
        if (prof?.type === 'local') {
            expect(prof.command).toEqual(['profile-expanded', ref('BASE_VAR')]);
        }
        expect(resolved.expandedSecrets).not.toContain('base-expanded');
        expect(resolved.expandedSecrets).toContain('profile-expanded');
    });
});

describe('profile-aware user-scope writes', () => {
    let dirs: { readonly root: string; readonly userConfigDir: string; readonly projectConfigPath: string };

    beforeEach(async () => {
        const root = await mkdtemp(join(tmpdir(), 'mcp-prof-write-'));
        dirs = {
            root,
            userConfigDir: join(root, 'config'),
            projectConfigPath: join(root, 'workspace', '.mcp.json'),
        };
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('creates mission-control.<profile>.jsonc when no candidate exists', async () => {
        await writeUserMcpServer(
            'srv',
            { type: 'local', command: ['npx', 'fs-mcp'] },
            { profileName: 'dev', userConfigDir: dirs.userConfigDir, projectConfigPath: dirs.projectConfigPath },
        );
        const createdPath = join(dirs.userConfigDir, 'mission-control.dev.jsonc');
        const onDisk = JSON.parse(await readFile(createdPath, 'utf8'));
        expect(onDisk.mcp.srv.command).toEqual(['npx', 'fs-mcp']);
        await expect(readFile(join(dirs.userConfigDir, 'config.json'), 'utf8')).rejects.toThrow();
    });

    it('rewrites an existing .jsonc candidate preserving the file path and JSON validity', async () => {
        const profilePath = join(dirs.userConfigDir, 'mission-control.dev.jsonc');
        await writeRaw(
            profilePath,
            [
                '{',
                '  // my dev profile',
                '  "mcp": {',
                '    "first": { "type": "local", "command": ["a"] }',
                '  }',
                '}',
            ].join('\n'),
        );
        await writeUserMcpServer(
            'second',
            { type: 'local', command: ['b'] },
            { profileName: 'dev', userConfigDir: dirs.userConfigDir, projectConfigPath: dirs.projectConfigPath },
        );
        const onDisk = JSON.parse(await readFile(profilePath, 'utf8'));
        expect(Object.keys(onDisk.mcp).sort()).toEqual(['first', 'second']);
        expect(onDisk.mcp.second.command).toEqual(['b']);
    });

    it('removeUserMcpServer writes through the same profile candidate', async () => {
        const profilePath = join(dirs.userConfigDir, 'mission-control.dev.jsonc');
        await writeRaw(
            profilePath,
            JSON.stringify({
                mcp: { keep: { type: 'local', command: ['k'] }, drop: { type: 'local', command: ['d'] } },
            }),
        );
        const removed = await removeUserMcpServer('drop', {
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
        });
        expect(removed).toBe(true);
        const onDisk = JSON.parse(await readFile(profilePath, 'utf8'));
        expect(Object.keys(onDisk.mcp)).toEqual(['keep']);
    });

    it('preserves parsed profile JSONC fields when adding a server', async () => {
        const profilePath = join(dirs.userConfigDir, 'mission-control.dev.jsonc');
        await writeRaw(
            profilePath,
            [
                '{',
                '  // parsed values survive, comments do not need to',
                '  "browser": { "browserURL": "http://127.0.0.1:9222" },',
                '  "lsp": { "command": ["rust-analyzer"], "environment": { "RUST_LOG": "debug" }, "timeoutMs": 1200 },',
                '  "mcp_env_allowlist": ["KEEP_ME"],',
                '  "mcp": { "existing": { "type": "local", "command": ["existing-mcp"] } }',
                '}',
            ].join('\n'),
        );

        await writeUserMcpServer(
            'added',
            { type: 'local', command: ['added-mcp'] },
            { profileName: 'dev', userConfigDir: dirs.userConfigDir, projectConfigPath: dirs.projectConfigPath },
        );

        expect(JSON.parse(await readFile(profilePath, 'utf8'))).toEqual({
            browser: { browserURL: 'http://127.0.0.1:9222' },
            lsp: { command: ['rust-analyzer'], environment: { RUST_LOG: 'debug' }, timeoutMs: 1200 },
            mcp_env_allowlist: ['KEEP_ME'],
            mcp: {
                existing: { type: 'local', command: ['existing-mcp'] },
                added: { type: 'local', command: ['added-mcp'] },
            },
        });
    });

    it('preserves parsed profile JSONC fields when removing a server', async () => {
        const profilePath = join(dirs.userConfigDir, 'mission-control.dev.jsonc');
        await writeRaw(
            profilePath,
            [
                '{',
                '  /* parsed values survive */',
                '  "browser": { "browserURL": "http://127.0.0.1:9222" },',
                '  "lsp": { "command": ["rust-analyzer"], "environment": { "RUST_LOG": "debug" }, "timeoutMs": 1200 },',
                '  "mcp_env_allowlist": ["KEEP_ME"],',
                '  "mcp": {',
                '    "keep": { "type": "local", "command": ["keep-mcp"] },',
                '    "remove": { "type": "local", "command": ["remove-mcp"] }',
                '  }',
                '}',
            ].join('\n'),
        );

        await expect(
            removeUserMcpServer('remove', {
                profileName: 'dev',
                userConfigDir: dirs.userConfigDir,
                projectConfigPath: dirs.projectConfigPath,
            }),
        ).resolves.toBe(true);

        expect(JSON.parse(await readFile(profilePath, 'utf8'))).toEqual({
            browser: { browserURL: 'http://127.0.0.1:9222' },
            lsp: { command: ['rust-analyzer'], environment: { RUST_LOG: 'debug' }, timeoutMs: 1200 },
            mcp_env_allowlist: ['KEEP_ME'],
            mcp: { keep: { type: 'local', command: ['keep-mcp'] } },
        });
    });

    it('project-scope writes ignore the profile and always target .mcp.json', async () => {
        await writeProjectMcpServer(
            'web',
            { type: 'remote', url: 'https://example.test/mcp' },
            { profileName: 'dev', projectConfigPath: dirs.projectConfigPath },
        );
        const onDisk = JSON.parse(await readFile(dirs.projectConfigPath, 'utf8'));
        expect(onDisk.mcpServers.web.url).toBe('https://example.test/mcp');
        await expect(readFile(join(dirs.root, 'workspace', '.mcp.dev.json'), 'utf8')).rejects.toThrow();
    });
});

describe('T6 guardrail: .mcp.<profile>.json[c] project files are never read', () => {
    let dirs: { readonly root: string; readonly userConfigDir: string; readonly projectConfigPath: string };

    beforeEach(async () => {
        const root = await mkdtemp(join(tmpdir(), 'mcp-t6-project-ignore-'));
        dirs = {
            root,
            userConfigDir: join(root, 'config'),
            projectConfigPath: join(root, 'workspace', '.mcp.json'),
        };
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('a sibling .mcp.dev.json is ignored even when --profile dev is selected', async () => {
        await writeRaw(join(dirs.userConfigDir, 'mission-control.dev.jsonc'), JSON.stringify({ mcp: {} }));
        await writeRaw(
            dirs.projectConfigPath,
            JSON.stringify({ mcpServers: { canonical: { type: 'local', command: ['real-bin'] } } }),
        );
        await writeRaw(
            join(dirs.root, 'workspace', '.mcp.dev.json'),
            JSON.stringify({ mcpServers: { profileOnlyLeak: { type: 'local', command: ['leak-bin'] } } }),
        );

        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });

        const names = resolved.servers.map((server) => server.name);
        expect(names).toContain('canonical');
        expect(names).not.toContain('profileOnlyLeak');
        expect(resolved.errors).toEqual([]);
    });

    it('a sibling .mcp.dev.jsonc is ignored too (both extensions)', async () => {
        await writeRaw(join(dirs.userConfigDir, 'mission-control.dev.jsonc'), JSON.stringify({ mcp: {} }));
        await writeRaw(
            dirs.projectConfigPath,
            JSON.stringify({ mcpServers: { canonical: { type: 'local', command: ['real-bin'] } } }),
        );
        await writeRaw(
            join(dirs.root, 'workspace', '.mcp.dev.jsonc'),
            JSON.stringify({ mcpServers: { jsoncLeak: { type: 'local', command: ['leak-bin'] } } }),
        );

        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            userConfigDir: dirs.userConfigDir,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });

        const names = resolved.servers.map((server) => server.name);
        expect(names).toContain('canonical');
        expect(names).not.toContain('jsoncLeak');
    });
});

describe('mcp config-writes concurrency', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
        await writeRaw(dirs.userConfigPath, JSON.stringify({ mcp: {} }));
        await writeRaw(dirs.projectConfigPath, JSON.stringify({ mcpServers: {} }));
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('serializes concurrent writeUserMcpServer without dropping servers', async () => {
        await Promise.all([
            writeUserMcpServer(
                'a',
                { type: 'local', command: ['a-bin'] },
                { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
            ),
            writeUserMcpServer(
                'b',
                { type: 'local', command: ['b-bin'] },
                { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
            ),
            writeUserMcpServer(
                'c',
                { type: 'local', command: ['c-bin'] },
                { userConfigPath: dirs.userConfigPath, projectConfigPath: dirs.projectConfigPath },
            ),
        ]);
        const raw = JSON.parse(await readFile(dirs.userConfigPath, 'utf8')) as {
            readonly mcp?: Record<string, unknown>;
        };
        expect(Object.keys(raw.mcp ?? {}).sort()).toEqual(['a', 'b', 'c']);
    });
});

describe('session_debug config isolation', () => {
    let dirs: TempDirs;

    beforeEach(async () => {
        dirs = await makeTempDirs();
    });

    afterEach(async () => {
        await rm(dirs.root, { recursive: true, force: true });
    });

    it('keeps diagnostic configuration isolated and preserves raw members during MCP edits', async () => {
        const userConfigPath = dirs.userConfigPath.replace(/\.json$/, '.jsonc');
        await writeRaw(
            userConfigPath,
            `{
  /* preserve */ "session_debug": { "enabled": true },
  "session_debug": { "enabled": false },
  "mcp": {}
}`,
        );

        await writeUserMcpServer('added', { type: 'local', command: ['added-bin'] }, { userConfigPath });

        const written = await readFile(userConfigPath, 'utf8');
        expect(written).toContain('/* preserve */');
        expect(written.match(/"session_debug"/g)).toHaveLength(2);

        const resolved = await loadResolvedMcpConfig({
            userConfigPath,
            projectConfigPath: dirs.projectConfigPath,
            env: {},
        });
        expect(resolved.errors).toEqual([]);
        expect(resolved.sessionDebugConfig.enabled).toBe(false);
        expect(resolved.sessionDebugError).toContain('duplicate');
        expect(resolved.servers.map((server) => server.name)).toContain('added');
    });
});
