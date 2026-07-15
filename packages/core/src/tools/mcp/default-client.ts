import type { ResolvedMcpServer } from './config';
import { RemoteMcpClient } from './http-client';
import { StdioMcpClient } from './stdio-client';

export function createDefaultMcpClient(
    server: ResolvedMcpServer,
    secrets: readonly string[],
    workspaceRoot: string,
): StdioMcpClient | RemoteMcpClient {
    if (server.type === 'local') {
        const args = server.command.length > 1 ? server.command.slice(1) : undefined;
        return new StdioMcpClient({
            command: server.command[0] ?? '',
            ...(args !== undefined ? { args } : {}),
            ...(server.environment !== undefined ? { env: server.environment } : {}),
            cwd: workspaceRoot,
            ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
            secrets,
        });
    }
    return new RemoteMcpClient({
        url: server.url,
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
        ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
        secrets,
    });
}
