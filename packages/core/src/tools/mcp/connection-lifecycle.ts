import type { McpConfigScope } from './config';

export class McpConnectionLifecycle {
    private connectionPromise: Promise<void> | undefined;
    private disconnectPromise: Promise<void> | undefined;
    private readonly quarantinedScopes = new Set<McpConfigScope>();
    private readonly scopeDisconnectPromises = new Map<McpConfigScope, Promise<void>>();
    private closed = false;

    connect(connect: () => Promise<void>): Promise<void> {
        if (this.closed) return this.disconnectPromise ?? Promise.resolve();
        this.connectionPromise ??= connect();
        return this.connectionPromise;
    }

    disconnectAll(disconnect: () => Promise<void>): Promise<void> {
        if (this.disconnectPromise === undefined) {
            this.closed = true;
            this.disconnectPromise = this.disconnectAllAfterConnection(disconnect);
        }
        return this.disconnectPromise;
    }

    disconnectScope(scope: McpConfigScope, disconnect: () => Promise<void>): Promise<void> {
        if (this.closed) return this.disconnectPromise ?? Promise.resolve();
        const existing = this.scopeDisconnectPromises.get(scope);
        if (existing !== undefined) return existing;
        this.quarantinedScopes.add(scope);
        const disconnectPromise = this.disconnectAfterConnection(disconnect);
        this.scopeDisconnectPromises.set(scope, disconnectPromise);
        return disconnectPromise;
    }

    isClosed(): boolean {
        return this.closed;
    }

    isScopeQuarantined(scope: McpConfigScope): boolean {
        return this.quarantinedScopes.has(scope);
    }

    private async disconnectAllAfterConnection(disconnect: () => Promise<void>): Promise<void> {
        await this.connectionPromise?.catch(() => undefined);
        await Promise.all(this.scopeDisconnectPromises.values());
        await disconnect();
    }

    private async disconnectAfterConnection(disconnect: () => Promise<void>): Promise<void> {
        await this.connectionPromise?.catch(() => undefined);
        await disconnect();
    }
}
