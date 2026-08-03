import type { McpConfig, McpConfigEntry } from '@mission-control/protocol';
import { McpConfigSchema, McpProjectConfigSchema, MissionControlConfigSchema } from '@mission-control/protocol';
import { resolveProjectConfigPath, resolveUserConfigPathForWrite } from './config-paths';
import { readProjectConfig, readUserConfig } from './config-readers';
import type { LoadMcpConfigOptions } from './config-types';
import { serializeConfigPreservingSessionDebug } from './session-debug-config-document';
import { atomicWriteFile, atomicWriteJsonFile } from '../../persistence/atomic-write';

export async function writeUserMcpServer(
    name: string,
    entry: McpConfigEntry,
    options: LoadMcpConfigOptions = {},
): Promise<void> {
    const userConfigPath = resolveUserConfigPathForWrite(options);
    const existing = await readUserConfig(userConfigPath);
    if (existing.error !== undefined) throw new Error(`cannot write to ${userConfigPath}: ${existing.error}`);
    const nextMcp = McpConfigSchema.parse({ ...(existing.config?.mcp ?? {}), [name]: entry });
    const nextConfig = MissionControlConfigSchema.parse({
        ...(existing.config ?? {}),
        mcp: nextMcp,
    });
    await atomicWriteFile(
        userConfigPath,
        serializeConfigPreservingSessionDebug(nextConfig, existing.sessionDebugSourceMembers),
        { mode: 0o600 },
    );
}

export async function writeProjectMcpServer(
    name: string,
    entry: McpConfigEntry,
    options: LoadMcpConfigOptions = {},
): Promise<void> {
    const projectConfigPath = resolveProjectConfigPath(options);
    const existing = await readProjectConfig(projectConfigPath);
    if (existing.error !== undefined) throw new Error(`cannot write to ${projectConfigPath}: ${existing.error}`);
    const nextServers = McpConfigSchema.parse({ ...(existing.config?.mcpServers ?? {}), [name]: entry });
    const nextConfig = McpProjectConfigSchema.parse({ ...(existing.config ?? {}), mcpServers: nextServers });
    await atomicWriteJsonFile(projectConfigPath, nextConfig);
}

export async function removeUserMcpServer(name: string, options: LoadMcpConfigOptions = {}): Promise<boolean> {
    const userConfigPath = resolveUserConfigPathForWrite(options);
    const existing = await readUserConfig(userConfigPath);
    if (existing.error !== undefined) throw new Error(`cannot write to ${userConfigPath}: ${existing.error}`);
    if (existing.config?.mcp === undefined || !(name in existing.config.mcp)) return false;
    const remaining = withoutEntry(existing.config.mcp, name);
    const nextConfig = MissionControlConfigSchema.parse({
        ...(existing.config ?? {}),
        mcp: McpConfigSchema.parse(remaining),
    });
    await atomicWriteFile(
        userConfigPath,
        serializeConfigPreservingSessionDebug(nextConfig, existing.sessionDebugSourceMembers),
        { mode: 0o600 },
    );
    return true;
}

export async function removeProjectMcpServer(name: string, options: LoadMcpConfigOptions = {}): Promise<boolean> {
    const projectConfigPath = resolveProjectConfigPath(options);
    const existing = await readProjectConfig(projectConfigPath);
    if (existing.error !== undefined) throw new Error(`cannot write to ${projectConfigPath}: ${existing.error}`);
    if (existing.config?.mcpServers === undefined || !(name in existing.config.mcpServers)) return false;
    const remaining = McpConfigSchema.parse(withoutEntry(existing.config.mcpServers, name));
    const nextConfig = McpProjectConfigSchema.parse({ ...(existing.config ?? {}), mcpServers: remaining });
    await atomicWriteJsonFile(projectConfigPath, nextConfig);
    return true;
}

function withoutEntry(entries: McpConfig, name: string): Record<string, McpConfigEntry> {
    return Object.fromEntries(Object.entries(entries).filter(([key]) => key !== name));
}
