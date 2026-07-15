import type { LocalMcpConfigEntry, McpConfig, McpConfigEntry, RemoteMcpConfigEntry } from '@mission-control/protocol';
import type { McpConfigScope, ResolvedMcpServer, ScopedMcpEntry } from './config-types.js';

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveMcpServers(
    userServers: McpConfig,
    projectServers: McpConfig,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): readonly ResolvedMcpServer[] {
    const merged = new Map<string, ScopedMcpEntry>();
    mergeEntries(merged, userServers, 'user');
    mergeEntries(merged, projectServers, 'project');
    const servers: ResolvedMcpServer[] = [];
    for (const [name, scoped] of merged) {
        const resolved = resolveEntry(name, scoped.scope, scoped.entry, allowlist, env, secrets);
        if (resolved !== undefined) servers.push(resolved);
    }
    return servers;
}

function mergeEntries(target: Map<string, ScopedMcpEntry>, entries: McpConfig, scope: McpConfigScope): void {
    for (const [name, entry] of Object.entries(entries)) target.set(name, { entry, scope });
}

function resolveEntry(
    name: string,
    scope: McpConfigScope,
    entry: McpConfigEntry,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): ResolvedMcpServer | undefined {
    const common = {
        name,
        scope,
        enabled: entry.enabled ?? true,
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    };
    return entry.type === 'local'
        ? resolveLocalEntry(common, entry, allowlist, env, secrets)
        : resolveRemoteEntry(common, entry, allowlist, env, secrets);
}

type ResolvedCommon = {
    readonly name: string;
    readonly scope: McpConfigScope;
    readonly enabled: boolean;
    readonly timeoutMs?: number;
};

function resolveLocalEntry(
    common: ResolvedCommon,
    entry: LocalMcpConfigEntry,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): ResolvedMcpServer {
    const command = entry.command.map((segment) => expandEnvVars(segment, allowlist, env, secrets));
    const environment = expandRecord(entry.environment, allowlist, env, secrets);
    return { ...common, type: 'local', command, ...(environment !== undefined ? { environment } : {}) };
}

function resolveRemoteEntry(
    common: ResolvedCommon,
    entry: RemoteMcpConfigEntry,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): ResolvedMcpServer {
    const url = expandEnvVars(entry.url, allowlist, env, secrets);
    const headers = expandRecord(entry.headers, allowlist, env, secrets);
    return { ...common, type: 'remote', url, ...(headers !== undefined ? { headers } : {}) };
}

function expandRecord(
    record: Readonly<Record<string, string>> | undefined,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): Record<string, string> | undefined {
    if (record === undefined) return undefined;
    const expanded: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
        const expandedValue = expandEnvVars(value, allowlist, env, secrets);
        expanded[key] = expandedValue;
        if (expandedValue.length > 0) secrets.add(expandedValue);
    }
    return expanded;
}

function expandEnvVars(
    value: string,
    allowlist: ReadonlySet<string>,
    env: Readonly<Record<string, string | undefined>>,
    secrets: Set<string>,
): string {
    return value.replace(ENV_VAR_PATTERN, (fullMatch, variableName: string) => {
        if (!allowlist.has(variableName)) return fullMatch;
        const envValue = env[variableName];
        if (envValue === undefined) return '';
        if (envValue.length > 0) secrets.add(envValue);
        return envValue;
    });
}
