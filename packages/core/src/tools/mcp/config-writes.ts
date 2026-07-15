import type { McpConfig, McpConfigEntry } from '@mission-control/protocol';
import { McpConfigSchema, McpProjectConfigSchema, MissionControlConfigSchema } from '@mission-control/protocol';
import { resolveProjectConfigPath, resolveUserConfigPathForWrite } from './config-paths.js';
import { readProjectConfig, readUserConfig } from './config-readers.js';
import type { LoadMcpConfigOptions } from './config-types.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
    await writeJsonFileAtomic(userConfigPath, nextConfig, { mode: 0o600 });
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
    await writeJsonFileAtomic(projectConfigPath, nextConfig, {});
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
    await writeJsonFileAtomic(userConfigPath, nextConfig, { mode: 0o600 });
    return true;
}

export async function removeProjectMcpServer(name: string, options: LoadMcpConfigOptions = {}): Promise<boolean> {
    const projectConfigPath = resolveProjectConfigPath(options);
    const existing = await readProjectConfig(projectConfigPath);
    if (existing.error !== undefined) throw new Error(`cannot write to ${projectConfigPath}: ${existing.error}`);
    if (existing.config?.mcpServers === undefined || !(name in existing.config.mcpServers)) return false;
    const remaining = McpConfigSchema.parse(withoutEntry(existing.config.mcpServers, name));
    const nextConfig = McpProjectConfigSchema.parse({ ...(existing.config ?? {}), mcpServers: remaining });
    await writeJsonFileAtomic(projectConfigPath, nextConfig, {});
    return true;
}

function withoutEntry(entries: McpConfig, name: string): Record<string, McpConfigEntry> {
    return Object.fromEntries(Object.entries(entries).filter(([key]) => key !== name));
}

async function writeJsonFileAtomic(
    targetPath: string,
    value: unknown,
    options: { readonly mode?: number },
): Promise<void> {
    const directory = dirname(targetPath);
    const tempPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
        await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
            flag: 'wx',
            ...(options.mode !== undefined ? { mode: options.mode } : {}),
        });
        if (options.mode !== undefined) await chmod(tempPath, options.mode);
        await rename(tempPath, targetPath);
    } finally {
        await rm(tempPath, { force: true });
    }
    if (options.mode !== undefined) await chmod(targetPath, options.mode);
}
