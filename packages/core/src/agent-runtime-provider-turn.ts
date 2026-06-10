import type { AgentEventEnvelope, ModelProviderSelection } from '@mission-control/protocol';
import { ProviderTurnRunner } from './providers/provider-turn-runner.js';
import { type ProviderAdapter, ProviderTurnError } from './providers/provider-turn-types.js';

export type RuntimeProviderPromptInput = {
    readonly provider: ProviderAdapter;
    readonly sessionId: string;
    readonly taskId: string;
    readonly prompt: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly providerTimeoutMs?: number;
    readonly providerRetryLimit?: number;
    readonly providerTurnLoopLimit?: number;
    readonly onEnvelope: (envelope: AgentEventEnvelope) => void;
};

export async function runRuntimeProviderPromptTask(input: RuntimeProviderPromptInput): Promise<string> {
    const runner = new ProviderTurnRunner({
        provider: input.provider,
        ...(input.providerTimeoutMs !== undefined ? { timeoutMs: input.providerTimeoutMs } : {}),
        ...(input.providerRetryLimit !== undefined ? { retryLimit: input.providerRetryLimit } : {}),
        ...(input.providerTurnLoopLimit !== undefined ? { toolCallLoopLimit: input.providerTurnLoopLimit } : {}),
    });
    const result = await runner.runTurn({
        sessionId: input.sessionId,
        turnId: input.taskId,
        requestId: `provider_request_${input.taskId}`,
        providerID: input.modelProviderSelection.providerID,
        modelID: input.modelProviderSelection.modelID,
        messages: [{ role: 'user', content: input.prompt }],
        startSequence: 0,
        onEnvelope: input.onEnvelope,
    });
    if (result.status === 'completed') {
        return result.message.content;
    }
    throw new ProviderTurnError(result.error);
}
