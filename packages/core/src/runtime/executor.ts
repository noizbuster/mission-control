import type { AgentExecutionContext, AgentTask, AgentTaskResult } from './execution-context.js';

export interface AgentExecutor {
    execute(task: AgentTask, context: AgentExecutionContext): Promise<AgentTaskResult>;
}
