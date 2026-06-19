import {
    type LoadMcpConfigOptions,
    loadResolvedMcpConfig,
    type McpClient,
    type McpToolInfo,
    RemoteMcpClient,
    type ResolvedMcpServer,
    removeProjectMcpServer,
    removeUserMcpServer,
    resolveProjectConfigPath,
    resolveUserConfigPath,
    StdioMcpClient,
    ToolExecutionError,
    writeProjectMcpServer,
    writeUserMcpServer,
} from '@mission-control/core';
import { type McpConfigEntry, McpConfigEntrySchema } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';

const SECRET_MASK = '***';

type TestableMcpClient = McpClient & { connect(): Promise<void>; close(): Promise<void> };

export type McpCommandOptions = Readonly<LoadMcpConfigOptions>;

export async function runMcpCommand(args: CliArgs, options: McpCommandOptions = {}): Promise<string> {
    switch (args.command) {
        case 'mcp-add':
            return runMcpAdd(args, options);
        case 'mcp-list':
            return runMcpList(options);
        case 'mcp-remove':
            return runMcpRemove(args, options);
        case 'mcp-test':
            return runMcpTest(args, options);
        default:
            throw new Error(`Unsupported mcp command: ${args.command}`);
    }
}

async function runMcpAdd(args: CliArgs, options: McpCommandOptions): Promise<string> {
    if (args.mcpName === undefined) {
        throw new Error('mcp add requires a server name');
    }
    const entry = buildEntryFromArgs(args);
    const scope = args.mcpScope ?? 'project';
    if (scope === 'user') {
        await writeUserMcpServer(args.mcpName, entry, options);
    } else {
        await writeProjectMcpServer(args.mcpName, entry, options);
    }
    const targetPath = scope === 'user' ? resolveUserConfigPath(options) : resolveProjectConfigPath(options);
    return `Added MCP server ${args.mcpName} (${scope} scope)\n  ${targetPath}\n`;
}

async function runMcpList(options: McpCommandOptions): Promise<string> {
    const resolved = await loadResolvedMcpConfig(options);
    const lines: string[] = ['MCP servers'];
    if (resolved.servers.length === 0) {
        lines.push('  (none configured)');
    }
    for (const server of resolved.servers) {
        lines.push(formatServerLine(server));
    }
    for (const error of resolved.errors) {
        lines.push(`Warning: ${error.source}: ${error.message}`);
    }
    lines.push('');
    return redactSecrets(lines.join('\n'), resolved.expandedSecrets);
}

async function runMcpRemove(args: CliArgs, options: McpCommandOptions): Promise<string> {
    if (args.mcpName === undefined) {
        throw new Error('mcp remove requires a server name');
    }
    const scope = args.mcpScope ?? 'project';
    const removed =
        scope === 'user'
            ? await removeUserMcpServer(args.mcpName, options)
            : await removeProjectMcpServer(args.mcpName, options);
    if (!removed) {
        return `MCP server ${args.mcpName} is not configured in the ${scope} scope\n`;
    }
    return `Removed MCP server ${args.mcpName} (${scope} scope)\n`;
}

async function runMcpTest(args: CliArgs, options: McpCommandOptions): Promise<string> {
    if (args.mcpName === undefined) {
        throw new Error('mcp test requires a server name');
    }
    const resolved = await loadResolvedMcpConfig(options);
    const server = resolved.servers.find((entry) => entry.name === args.mcpName);
    if (server === undefined) {
        return `MCP server ${args.mcpName} is not configured\n`;
    }
    if (!server.enabled) {
        return `MCP server ${args.mcpName} is disabled; enable it to test\n`;
    }
    const client = buildClientFromServer(server, resolved.expandedSecrets, options.workspaceRoot ?? process.cwd());
    let tools: readonly McpToolInfo[];
    try {
        await client.connect();
        tools = await client.listTools();
    } catch (error) {
        return formatTestFailure(args.mcpName, error);
    } finally {
        try {
            await client.close();
        } catch {
            // best-effort teardown
        }
    }
    const lines: string[] = [`MCP server ${args.mcpName} (${tools.length} tool${tools.length === 1 ? '' : 's'})`];
    for (const tool of tools) {
        lines.push(`  ${tool.name}${tool.description !== undefined ? ` - ${tool.description}` : ''}`);
    }
    lines.push('');
    return lines.join('\n');
}

function buildEntryFromArgs(args: CliArgs): McpConfigEntry {
    const type = args.mcpType ?? 'local';
    const enabled = args.mcpEnabled;
    const timeoutMs = args.mcpTimeoutMs;
    if (type === 'local') {
        const command = args.mcpCommand;
        if (command === undefined || command.length === 0) {
            throw new Error('mcp add --type local requires --command (at least one element)');
        }
        const environment = recordFromKeyValues(args.mcpEnv);
        const entry: McpConfigEntry = {
            type: 'local',
            command: [...command],
            ...(environment !== undefined ? { environment } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        };
        return validateEntry(entry);
    }
    if (args.mcpUrl === undefined) {
        throw new Error('mcp add --type remote requires --url');
    }
    const headers = recordFromKeyValues(args.mcpHeader);
    const entry: McpConfigEntry = {
        type: 'remote',
        url: args.mcpUrl,
        ...(headers !== undefined ? { headers } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    return validateEntry(entry);
}

function validateEntry(entry: McpConfigEntry): McpConfigEntry {
    const result = McpConfigEntrySchema.safeParse(entry);
    if (!result.success) {
        const first = result.error.issues[0];
        const detail = first === undefined ? 'invalid entry' : first.message;
        throw new Error(`invalid MCP server config: ${detail}`);
    }
    return result.data;
}

function recordFromKeyValues(
    pairs: readonly { readonly key: string; readonly value: string }[] | undefined,
): Record<string, string> | undefined {
    if (pairs === undefined || pairs.length === 0) {
        return undefined;
    }
    const record: Record<string, string> = {};
    for (const pair of pairs) {
        record[pair.key] = pair.value;
    }
    return record;
}

function formatServerLine(server: ResolvedMcpServer): string {
    const enabledLabel = server.enabled ? '' : ' (disabled)';
    if (server.type === 'local') {
        const commandLabel = server.command.join(' ');
        const envLines =
            server.environment === undefined
                ? []
                : Object.entries(server.environment).map(([key]) => `      ${key}=${SECRET_MASK}`);
        return [
            `  ${server.name} [local, ${server.scope}]${enabledLabel}`,
            `      command: ${commandLabel}`,
            ...(server.timeoutMs !== undefined ? [`      timeout: ${server.timeoutMs}ms`] : []),
            ...(envLines.length > 0 ? ['      environment:', ...envLines] : []),
        ].join('\n');
    }
    const headerLines =
        server.headers === undefined
            ? []
            : Object.entries(server.headers).map(([key]) => `      ${key}=${SECRET_MASK}`);
    return [
        `  ${server.name} [remote, ${server.scope}]${enabledLabel}`,
        `      url: ${server.url}`,
        ...(server.timeoutMs !== undefined ? [`      timeout: ${server.timeoutMs}ms`] : []),
        ...(headerLines.length > 0 ? ['      headers:', ...headerLines] : []),
    ].join('\n');
}

function buildClientFromServer(
    server: ResolvedMcpServer,
    secrets: readonly string[],
    workspaceRoot: string,
): TestableMcpClient {
    if (server.type === 'remote') {
        return new RemoteMcpClient({
            url: server.url,
            ...(server.headers !== undefined ? { headers: server.headers } : {}),
            ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
            secrets,
        });
    }
    const binary = server.command[0];
    if (binary === undefined) {
        throw new Error(`MCP server ${server.name} has an empty command`);
    }
    return new StdioMcpClient({
        command: binary,
        args: server.command.slice(1),
        cwd: workspaceRoot,
        ...(server.environment !== undefined ? { env: server.environment } : {}),
        ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
        secrets,
    });
}

function formatTestFailure(name: string, error: unknown): string {
    const message =
        error instanceof ToolExecutionError ? error.message : error instanceof Error ? error.message : String(error);
    return `MCP server ${name} test failed: ${message}\n`;
}

function redactSecrets(text: string, secrets: readonly string[]): string {
    const ordered = [...new Set(secrets)]
        .filter((value) => value.length > 0)
        .sort((left, right) => right.length - left.length);
    let current = text;
    for (const secret of ordered) {
        if (current.length === 0) {
            break;
        }
        if (current.includes(secret)) {
            current = current.split(secret).join('[REDACTED]');
        }
    }
    return current;
}
