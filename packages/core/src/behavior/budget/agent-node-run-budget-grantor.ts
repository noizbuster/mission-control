import type { AbgNodeModelOptions } from '@mission-control/protocol';
import { generateText } from 'ai';
import type { LlmActorModel } from '../nodes/llm-actor/llm-actor-node';
import {
    type NodeRunBudgetExtensionDecision,
    type NodeRunBudgetExtensionRequest,
    type NodeRunBudgetExtensionRequester,
    parseAgentBudgetDecisionText,
} from './node-run-budget-extension';

const SUPERVISOR_SYSTEM_PROMPT =
    'You are the Mission Control node-run budget supervisor agent (not a human). ' +
    'A workflow graph has exhausted its node-run budget. Decide whether productive work ' +
    'warrants more runs. GRANT when recent nodes show forward progress (diverse exploration, ' +
    'planning, verification). DENY when the work looks stuck, oscillating, or already spent ' +
    'its extension allowance. Reply with exactly one line and nothing else:\n' +
    'APPROVE <n>\n' +
    'or\n' +
    'DENY <short reason>\n' +
    'where <n> is additional node runs (positive integer, at most the proposed grant).';

export type AgentNodeRunBudgetGrantorOptions = {
    readonly resolveSdkModel: (options: AbgNodeModelOptions) => LlmActorModel;
    readonly model: AbgNodeModelOptions;
    readonly generate?: typeof generateText;
};

/**
 * Builds a parent-agent budget grantor: one short LLM turn that returns APPROVE/DENY.
 * Fail-closed on model/transport errors (deny).
 */
export function createAgentNodeRunBudgetGrantor(
    options: AgentNodeRunBudgetGrantorOptions,
): NodeRunBudgetExtensionRequester {
    const generate = options.generate ?? generateText;
    return async (request: NodeRunBudgetExtensionRequest): Promise<NodeRunBudgetExtensionDecision> => {
        try {
            const result = await generate({
                model: options.resolveSdkModel(options.model),
                system: SUPERVISOR_SYSTEM_PROMPT,
                prompt: formatBudgetRequestPrompt(request),
                maxOutputTokens: 64,
            });
            return parseAgentBudgetDecisionText(result.text, request.proposedGrant);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { granted: false, reason: `budget supervisor agent failed: ${message}` };
        }
    };
}

export function formatBudgetRequestPrompt(request: NodeRunBudgetExtensionRequest): string {
    const recent = request.recentNodeIds.length > 0 ? request.recentNodeIds.join(' → ') : '(none)';
    return [
        `graphId: ${request.graphId}`,
        `sessionId: ${request.sessionId}`,
        `used: ${request.used}`,
        `limit: ${request.limit}`,
        `proposedGrant: ${request.proposedGrant}`,
        `extensionsUsed: ${request.extensionsUsed}/${request.maxExtensions}`,
        `hardCeiling: ${request.hardCeiling}`,
        `recentNodeIds: ${recent}`,
        'Decide APPROVE <n> or DENY <reason>.',
    ].join('\n');
}
