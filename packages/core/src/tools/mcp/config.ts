/**
 * MCP config loader: discovers, parses, merges, and `${VAR}`-expands MCP server entries from the
 * global `config.json` (`mcp` + `mcp_env_allowlist`) and the project-local `.mcp.json`
 * (`mcpServers`). Mirrors the opencode + Claude-Code tier-2 config story.
 *
 * Merge rule: global entries are applied first; project entries override on name collision
 * (closer-wins, opencode precedent).
 *
 * Security boundary (load-bearing): `${VAR}` expansion is gated by `mcp_env_allowlist`, which is
 * read ONLY from the global/user config. A project `.mcp.json` cannot extend the allowlist. A
 * non-allowlisted `${SECRET}` is left as the literal token (NEVER expanded), so a secret value can
 * never reach the resolved config through an un-allowed variable. Each EXPANDED value is collected
 * into `expandedSecrets` so todo 7 can pass them to the MCP clients' redaction layer.
 */

import { appName } from '@mission-control/config';
import type {
    LocalMcpConfigEntry,
    McpConfig,
    McpConfigEntry,
    McpProjectConfig,
    MissionControlConfig,
    RemoteMcpConfigEntry,
} from '@mission-control/protocol';
import { McpConfigSchema, McpProjectConfigSchema, MissionControlConfigSchema } from '@mission-control/protocol';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export type McpConfigScope = 'user' | 'project';

export type ResolvedMcpServer =
    | {
          readonly name: string;
          readonly scope: McpConfigScope;
          readonly type: 'local';
          readonly enabled: boolean;
          readonly timeoutMs?: number;
          readonly command: readonly string[];
          readonly environment?: Readonly<Record<string, string>>;
      }
    | {
          readonly name: string;
          readonly scope: McpConfigScope;
          readonly type: 'remote';
          readonly enabled: boolean;
          readonly timeoutMs?: number;
          readonly url: string;
          readonly headers?: Readonly<Record<string, string>>;
      };

export type McpConfigParseError = {
    readonly source: string;
    readonly message: string;
};

export type ResolvedMcpConfig = {
    readonly servers: readonly ResolvedMcpServer[];
    readonly expandedSecrets: readonly string[];
    readonly errors: readonly McpConfigParseError[];
};

export type LoadMcpConfigOptions = {
    readonly workspaceRoot?: string;
    readonly userConfigPath?: string;
    readonly projectConfigPath?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
};

export const mcpConfigDirEnvKey = 'MCTRL_CONFIG_DIR';
const windowsAppDataEnvKey = 'APPDATA';
const xdgConfigHomeEnvKey = 'XDG_CONFIG_HOME';
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveUserConfigPath(options: LoadMcpConfigOptions = {}): string {
    if (options.userConfigPath !== undefined) {
        return options.userConfigPath;
    }
    const env = options.env ?? process.env;
    const override = env[mcpConfigDirEnvKey];
    if (override !== undefined && override.length > 0) {
        return join(override, 'config.json');
    }
    const homeDir = homedir();
    const platform = process.platform;
    if (platform === 'win32') {
        const appData = env[windowsAppDataEnvKey];
        const configHome = appData !== undefined && appData.length > 0 ? appData : join(homeDir, 'AppData', 'Roaming');
        return join(configHome, appName, 'config.json');
    }
    const xdgConfigHome = env[xdgConfigHomeEnvKey];
    const configHome =
        xdgConfigHome !== undefined && xdgConfigHome.length > 0 ? xdgConfigHome : join(homeDir, '.config');
    return join(configHome, appName, 'config.json');
}

export function resolveProjectConfigPath(options: LoadMcpConfigOptions = {}): string {
    if (options.projectConfigPath !== undefined) {
        return options.projectConfigPath;
    }
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    return join(workspaceRoot, '.mcp.json');
}

export async function loadResolvedMcpConfig(options: LoadMcpConfigOptions = {}): Promise<ResolvedMcpConfig> {
    const env = options.env ?? process.env;
    const userConfigPath = resolveUserConfigPath(options);
    const projectConfigPath = resolveProjectConfigPath(options);

    const userResult = await readUserConfig(userConfigPath);
    const projectResult = await readProjectConfig(projectConfigPath);

    const errors: McpConfigParseError[] = [];
    if (userResult.error !== undefined) {
        errors.push({ source: userConfigPath, message: userResult.error });
    }
    if (projectResult.error !== undefined) {
        errors.push({ source: projectConfigPath, message: projectResult.error });
    }

    const allowlist = new Set<string>(userResult.config?.mcp_env_allowlist ?? []);
    const expandedSecrets = new Set<string>();

    const userServers = userResult.config?.mcp ?? {};
    const projectServers = projectResult.config?.mcpServers ?? {};

    const merged: Map<string, { entry: McpConfigEntry; scope: McpConfigScope }> = new Map();
    for (const [name, entry] of Object.entries(userServers)) {
        merged.set(name, { entry, scope: 'user' });
    }
    for (const [name, entry] of Object.entries(projectServers)) {
        merged.set(name, { entry, scope: 'project' });
    }

    const servers: ResolvedMcpServer[] = [];
    for (const [name, { entry, scope }] of merged) {
        const resolved = resolveEntry(name, scope, entry, allowlist, env, expandedSecrets);
        if (resolved !== undefined) {
            servers.push(resolved);
        }
    }

    return { servers, expandedSecrets: [...expandedSecrets], errors };
}

function resolveEntry(
    name: string,
    scope: McpConfigScope,
    entry: McpConfigEntry,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): ResolvedMcpServer | undefined {
    const enabled = entry.enabled ?? true;
    const common = { name, scope, enabled, ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}) };
    if (entry.type === 'local') {
        return resolveLocalEntry(common, entry, allowlist, env, secrets);
    }
    return resolveRemoteEntry(common, entry, allowlist, env, secrets);
}

function resolveLocalEntry(
    common: {
        readonly name: string;
        readonly scope: McpConfigScope;
        readonly enabled: boolean;
        readonly timeoutMs?: number;
    },
    entry: LocalMcpConfigEntry,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): ResolvedMcpServer {
    const command = entry.command.map((segment: string) => expandEnvVars(segment, allowlist, env, secrets));
    const environment = expandRecord(entry.environment, allowlist, env, secrets);
    return {
        ...common,
        type: 'local',
        command,
        ...(environment !== undefined ? { environment } : {}),
    };
}

function resolveRemoteEntry(
    common: {
        readonly name: string;
        readonly scope: McpConfigScope;
        readonly enabled: boolean;
        readonly timeoutMs?: number;
    },
    entry: RemoteMcpConfigEntry,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): ResolvedMcpServer {
    const url = expandEnvVars(entry.url, allowlist, env, secrets);
    const headers = expandRecord(entry.headers, allowlist, env, secrets);
    return {
        ...common,
        type: 'remote',
        url,
        ...(headers !== undefined ? { headers } : {}),
    };
}

function expandRecord(
    record: Readonly<Record<string, string>> | undefined,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): Record<string, string> | undefined {
    if (record === undefined) {
        return undefined;
    }
    const expanded: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
        expanded[key] = expandEnvVars(value, allowlist, env, secrets);
    }
    return expanded;
}

function expandEnvVars(
    value: string,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): string {
    return value.replace(ENV_VAR_PATTERN, (fullMatch, varName: string) => {
        if (!allowlist.has(varName)) {
            return fullMatch;
        }
        const envValue = env[varName];
        if (envValue === undefined) {
            return '';
        }
        if (envValue.length > 0) {
            secrets.add(envValue);
        }
        return envValue;
    });
}

type ReadUserResult = { readonly config: MissionControlConfig | undefined; readonly error?: string };

async function readUserConfig(userConfigPath: string): Promise<ReadUserResult> {
    const contents = await readConfigText(userConfigPath);
    if (contents === undefined) {
        return { config: undefined };
    }
    const parsed = parseJson(userConfigPath, contents);
    if (typeof parsed !== 'object') {
        return { config: undefined, error: parsed };
    }
    const result = MissionControlConfigSchema.safeParse(parsed.value);
    if (!result.success) {
        return { config: undefined, error: formatZodError(result.error) };
    }
    return { config: result.data };
}

type ReadProjectResult = { readonly config: McpProjectConfig | undefined; readonly error?: string };

async function readProjectConfig(projectConfigPath: string): Promise<ReadProjectResult> {
    const contents = await readConfigText(projectConfigPath);
    if (contents === undefined) {
        return { config: undefined };
    }
    const parsed = parseJson(projectConfigPath, contents);
    if (typeof parsed !== 'object') {
        return { config: undefined, error: parsed };
    }
    const result = McpProjectConfigSchema.safeParse(parsed.value);
    if (!result.success) {
        return { config: undefined, error: formatZodError(result.error) };
    }
    return { config: result.data };
}

async function readConfigText(configPath: string): Promise<string | undefined> {
    try {
        const contents = await readFile(configPath, 'utf8');
        return contents.trim().length === 0 ? undefined : contents;
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return undefined;
        }
        throw error;
    }
}

type JsonParseOutcome = { readonly value: unknown } | string;

function parseJson(source: string, contents: string): JsonParseOutcome | string {
    try {
        return { value: JSON.parse(contents) };
    } catch (error: unknown) {
        const raw = error instanceof Error ? error.message : String(error);
        return `failed to parse JSON in ${source}: ${raw}`;
    }
}

function formatZodError(error: {
    readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string {
    const lines = error.issues.map((issue) => {
        const path = issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.');
        return `  at ${path}: ${issue.message}`;
    });
    return `config validation failed:\n${lines.join('\n')}`;
}

export type ReadScopeServersResult = {
    readonly servers: McpConfig;
    readonly allowlist?: readonly string[];
    readonly error?: string;
};

export async function readUserScopeServers(options: LoadMcpConfigOptions = {}): Promise<ReadScopeServersResult> {
    const userConfigPath = resolveUserConfigPath(options);
    const userResult = await readUserConfig(userConfigPath);
    const result: ReadScopeServersResult = {
        servers: userResult.config?.mcp ?? {},
        ...(userResult.config?.mcp_env_allowlist !== undefined
            ? { allowlist: userResult.config.mcp_env_allowlist }
            : {}),
        ...(userResult.error !== undefined ? { error: userResult.error } : {}),
    };
    return result;
}

export async function readProjectScopeServers(options: LoadMcpConfigOptions = {}): Promise<ReadScopeServersResult> {
    const projectConfigPath = resolveProjectConfigPath(options);
    const projectResult = await readProjectConfig(projectConfigPath);
    return {
        servers: projectResult.config?.mcpServers ?? {},
        ...(projectResult.error !== undefined ? { error: projectResult.error } : {}),
    };
}

export async function writeUserMcpServer(
    name: string,
    entry: McpConfigEntry,
    options: LoadMcpConfigOptions = {},
): Promise<void> {
    const userConfigPath = resolveUserConfigPath(options);
    const existing = await readUserConfig(userConfigPath);
    if (existing.error !== undefined) {
        throw new Error(`cannot write to ${userConfigPath}: ${existing.error}`);
    }
    const currentMcp: McpConfig = existing.config?.mcp ?? {};
    const nextMcp = McpConfigSchema.parse({ ...currentMcp, [name]: entry });
    const nextConfig: MissionControlConfig = {
        ...(existing.config?.mcp_env_allowlist !== undefined
            ? { mcp_env_allowlist: existing.config.mcp_env_allowlist }
            : {}),
        mcp: nextMcp,
    };
    const parsed = MissionControlConfigSchema.parse(nextConfig);
    await writeJsonFileAtomic(userConfigPath, parsed, { mode: 0o600 });
}

export async function writeProjectMcpServer(
    name: string,
    entry: McpConfigEntry,
    options: LoadMcpConfigOptions = {},
): Promise<void> {
    const projectConfigPath = resolveProjectConfigPath(options);
    const existing = await readProjectConfig(projectConfigPath);
    if (existing.error !== undefined) {
        throw new Error(`cannot write to ${projectConfigPath}: ${existing.error}`);
    }
    const currentServers: McpConfig = existing.config?.mcpServers ?? {};
    const nextServers = McpConfigSchema.parse({ ...currentServers, [name]: entry });
    const parsed = McpProjectConfigSchema.parse({ mcpServers: nextServers });
    await writeJsonFileAtomic(projectConfigPath, parsed, {});
}

export async function removeUserMcpServer(name: string, options: LoadMcpConfigOptions = {}): Promise<boolean> {
    const userConfigPath = resolveUserConfigPath(options);
    const existing = await readUserConfig(userConfigPath);
    if (existing.config === undefined || existing.config.mcp === undefined || !(name in existing.config.mcp)) {
        return false;
    }
    const remaining = Object.fromEntries(Object.entries(existing.config.mcp).filter(([key]) => key !== name));
    const nextConfig: MissionControlConfig = {
        ...(existing.config.mcp_env_allowlist !== undefined
            ? { mcp_env_allowlist: existing.config.mcp_env_allowlist }
            : {}),
        mcp: McpConfigSchema.parse(remaining),
    };
    const parsed = MissionControlConfigSchema.parse(nextConfig);
    await writeJsonFileAtomic(userConfigPath, parsed, { mode: 0o600 });
    return true;
}

export async function removeProjectMcpServer(name: string, options: LoadMcpConfigOptions = {}): Promise<boolean> {
    const projectConfigPath = resolveProjectConfigPath(options);
    const existing = await readProjectConfig(projectConfigPath);
    if (
        existing.config === undefined ||
        existing.config.mcpServers === undefined ||
        !(name in existing.config.mcpServers)
    ) {
        return false;
    }
    const remaining = Object.fromEntries(Object.entries(existing.config.mcpServers).filter(([key]) => key !== name));
    const parsed = McpProjectConfigSchema.parse({ mcpServers: McpConfigSchema.parse(remaining) });
    await writeJsonFileAtomic(projectConfigPath, parsed, {});
    return true;
}

type WriteOptions = { readonly mode?: number };

async function writeJsonFileAtomic(targetPath: string, value: unknown, options: WriteOptions): Promise<void> {
    const directory = dirname(targetPath);
    const tempPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
        const writeFlags: { readonly flag: string; readonly mode?: number } = {
            flag: 'wx',
            ...(options.mode !== undefined ? { mode: options.mode } : {}),
        };
        await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, writeFlags);
        if (options.mode !== undefined) {
            await chmod(tempPath, options.mode);
        }
        await rename(tempPath, targetPath);
    } finally {
        await rm(tempPath, { force: true });
    }
    if (options.mode !== undefined) {
        await chmod(targetPath, options.mode);
    }
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
