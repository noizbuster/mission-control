import type { AgentExecutionContext } from '../runtime/execution-context.js';

export type SubAgentRunInput = {
    readonly prompt: string;
    readonly metadata?: Record<string, unknown>;
};

export type SubAgentRunOutput = {
    readonly output: string;
    readonly metadata?: Record<string, unknown>;
};

/**
 * @deprecated Use AgentDefinition from '@mission-control/protocol' instead.
 */
export interface SubAgent {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    run(input: SubAgentRunInput, context: AgentExecutionContext): Promise<SubAgentRunOutput>;
}
