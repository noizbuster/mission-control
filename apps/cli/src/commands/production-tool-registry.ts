import type { BrowserToolAdvertisement, ToolRegistryWithMcp } from '@mission-control/core';

export type ProductionToolCleanup = () => Promise<void>;

export type ProductionToolRegistryResources = ToolRegistryWithMcp & {
    readonly monitorCleanup: ProductionToolCleanup | null;
};

export type ProductionToolRegistry = ProductionToolRegistryResources & {
    readonly browserTool: BrowserToolAdvertisement | null;
    readonly ownsMcpConnectionManager: boolean;
};

export type CloseProductionToolRegistryOptions = {
    readonly disconnectMcp?: boolean;
};

export function createProductionToolRegistry(
    tools: ProductionToolRegistryResources,
    browserTool: BrowserToolAdvertisement | null,
    ownsMcpConnectionManager: boolean,
): ProductionToolRegistry {
    return { ...tools, browserTool, ownsMcpConnectionManager };
}

export async function closeProductionToolRegistry(
    tools: ProductionToolRegistry,
    options: CloseProductionToolRegistryOptions = {},
): Promise<void> {
    const disconnectMcp = options.disconnectMcp ?? tools.ownsMcpConnectionManager;
    const settlements = await Promise.allSettled([
        ...(disconnectMcp ? [tools.mcpConnectionManager.disconnectAll()] : []),
        tools.browserTool?.close(),
        tools.monitorCleanup?.(),
    ]);
    const cleanupErrors = tools.browserTool?.getCleanupErrors() ?? [];
    const errors: unknown[] = settlements
        .filter((settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected')
        .map((settlement) => settlement.reason);
    errors.push(...cleanupErrors.map((message) => new Error(message)));
    if (errors.length > 0) throw new AggregateError(errors, 'production tool cleanup failed');
}

export async function withProductionToolSetup<T>(
    tools: ProductionToolRegistry,
    setup: () => T | Promise<T>,
): Promise<T> {
    try {
        return await setup();
    } catch (error: unknown) {
        return failProductionToolSetup(error, tools, {}, 'production');
    }
}

export async function completeProductionToolSetup(
    tools: ProductionToolRegistryResources,
    ownsMcpConnectionManager: boolean,
    setup: () => Promise<BrowserToolAdvertisement | null>,
    label: string,
): Promise<ProductionToolRegistry> {
    let browserTool: BrowserToolAdvertisement | null = null;
    try {
        browserTool = await setup();
        return createProductionToolRegistry(tools, browserTool, ownsMcpConnectionManager);
    } catch (error: unknown) {
        return failProductionToolSetup(
            error,
            createProductionToolRegistry(tools, browserTool, ownsMcpConnectionManager),
            {},
            label,
        );
    }
}

export async function failProductionToolSetup(
    cause: unknown,
    tools: ProductionToolRegistry,
    options: CloseProductionToolRegistryOptions,
    label: string,
): Promise<never> {
    try {
        await closeProductionToolRegistry(tools, options);
    } catch (cleanupError: unknown) {
        throw new AggregateError([cause, cleanupError], `${label} tool setup and cleanup failed`);
    }
    throw cause;
}
