import type { ProviderTurnRunnerOptions } from '../providers/provider-turn-types.js';

type ProviderRunnerOptionSource = {
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
};

export function providerRunnerOptions(
    options: ProviderRunnerOptionSource,
): Pick<ProviderTurnRunnerOptions, 'timeoutMs' | 'retryLimit' | 'toolCallLoopLimit'> {
    return {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
        ...(options.toolCallLoopLimit !== undefined ? { toolCallLoopLimit: options.toolCallLoopLimit } : {}),
    };
}
