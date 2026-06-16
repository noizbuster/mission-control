/**
 * Spawn a child coding-agent run (ABG §10.6, Phase 6 deferred item).
 *
 * Wires the `task` tool's `spawn` contract to the real runtime: builds a CHILD permission
 * policy (destructive kinds dropped) + a CHILD tool registry (the `task` tool absent — the
 * registry-layer recursion guard), then runs the coding-agent graph with the parent's model
 * resolver. The child's final assistant message becomes the task's `summary`.
 *
 * This is the runtime half of the `task` tool pair: `tools/task-tool.ts` is the model-facing
 * contract + recursion guard; this module is the runtime that knows how to build a graph.
 */
import type { AbgNodeModelOptions } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { TaskOutput } from '../../tools/task-tool.js';
import { createChildToolRegistry } from '../../tools/task-tool.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { createCodingAgentGraph } from '../coding-agent-graph.js';
import { createCodingAgentNodeRegistry } from '../coding-agent-registry.js';
import { runAbgGraph } from '../graph-runner.js';
import type { LlmActorModel } from '../nodes/llm-actor/llm-actor-node.js';

export type SpawnChildInput = {
    readonly description: string;
    readonly prompt: string;
    /** Resolves the child's model the same way the parent's is resolved. */
    readonly resolveSdkModel: (options: AbgNodeModelOptions) => LlmActorModel;
    readonly model: AbgNodeModelOptions;
    /**
     * The parent's tool registry — filtered to a child-safe, task-free surface via
     * `createChildToolRegistry`. Child safety is enforced HERE (the registry layer): the
     * child cannot see destructive tools OR the `task` tool, so neither a prompt nor a
     * permission rule can re-enable them (ABG §10.6).
     */
    readonly parentToolRegistry: ToolRegistry;
    readonly now: () => string;
    readonly signal?: AbortSignal;
    /** Unique session id for the child run (caller-supplied for determinism/testability). */
    readonly sessionId: string;
    readonly summaryLimit?: number;
};

/** Build + run the child graph and return its outcome as a `TaskOutput`. */
export async function spawnChildCodingAgent(input: SpawnChildInput): Promise<TaskOutput> {
    const childToolRegistry = createChildToolRegistry(input.parentToolRegistry);

    const result = await runAbgGraph({
        graph: createCodingAgentGraph({ model: input.model }),
        sessionId: input.sessionId,
        now: input.now,
        modelProviderSelection: input.model,
        registry: createCodingAgentNodeRegistry(),
        resolveSdkModel: input.resolveSdkModel,
        toolRegistry: childToolRegistry,
        initialMessages: [{ role: 'user', content: input.prompt }],
        ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
    });

    const summary = latestAssistantText(result.finalMessages ?? [], input.summaryLimit ?? 4000);
    return {
        description: input.description,
        status: result.status === 'completed' ? 'completed' : 'failed',
        summary,
    };
}

function latestAssistantText(messages: readonly ModelMessage[], limit: number): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'assistant') {
            const text = messageText(message);
            if (text !== undefined) {
                return text.length > limit ? `${text.slice(0, limit)}…` : text;
            }
        }
    }
    return '';
}

function messageText(message: ModelMessage): string | undefined {
    const content = message.content;
    if (typeof content === 'string') {
        return content.length > 0 ? content : undefined;
    }
    const text = content
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
    return text.length > 0 ? text : undefined;
}
