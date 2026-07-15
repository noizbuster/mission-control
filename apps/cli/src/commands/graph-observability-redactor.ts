import {
    composeObservabilityRedactors,
    createProviderAuthStoreObservabilityRedactor,
    type McpConnectionManager,
    type ObservabilityRedactor,
    type ProviderAuthStore,
} from '@mission-control/core';

export async function createGraphObservabilityRedactor(input: {
    readonly mcpConnectionManager: McpConnectionManager;
    readonly authStore?: ProviderAuthStore;
}): Promise<ObservabilityRedactor> {
    const redactors: ObservabilityRedactor[] = [input.mcpConnectionManager.getObservabilityRedactor()];
    if (input.authStore !== undefined) {
        redactors.push(await createProviderAuthStoreObservabilityRedactor(input.authStore));
    }
    return composeObservabilityRedactors(redactors);
}
