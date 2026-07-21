/**
 * Spawn a child coding-agent run (ABG §10.6, Phase 6 deferred item).
 *
 * Wires a resolved child context to the coding-agent graph. The caller supplies the child tool
 * registry: the full-parity path constructs it with `buildChildToolSurface`, while the deprecated
 * simple-task factory supplies its compatibility-filtered registry. This module does not derive
 * authority from parent/session permission rules. The child's final assistant message becomes the
 * task's `summary`.
 *
 * This is the runtime half of the `task` tool pair: `tools/task-tool.ts` is the model-facing
 * contract + recursion guard; this module is the runtime that knows how to build a graph.
 */
import type { AbgNodeModelOptions, AbgSignal, AgentEvent } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ObservabilityRedactor } from '../../providers/observability-redactor';
import { createObservabilityRedactor } from '../../providers/observability-redactor';
import type { SessionControlEpoch } from '../../runtime/session-control-cancellation';
import type { AskUserQuestionRequest } from '../../tools/ask-user-schemas';
import { ASK_USER_BLOCKED_ANSWER, createAskUserToolRegistration } from '../../tools/ask-user-tool';
import type {
    ChildAskUserParentAnswerer,
    ChildAskUserSourceFields,
} from '../../tools/child-ask-user-router';
import {
    formatChildAskUserHeader,
    routeChildAskUser,
    withChildAskUserSource,
} from '../../tools/child-ask-user-router';
import type { TaskOutput } from '../../tools/task-tool';
import type { ToolRegistry } from '../../tools/tool-registry';
import { createCodingAgentGraph } from '../coding-agent-graph';
import { createCodingAgentNodeRegistry } from '../coding-agent-registry';
import { runAbgGraph } from '../graph-runner';
import type { LlmActorModel } from '../nodes/llm-actor/llm-actor-node';

/**
 * Optional callbacks that route a child's host-facing interactions (ask_user overlay,
 * durable-event rendering, signal taps) back to the parent TUI. When absent, the child runs
 * fully isolated: ask_user returns the {@linkcode ASK_USER_BLOCKED_ANSWER} sentinel, signals
 * and durable events are dropped at the child boundary.
 *
 * The fields are all optional and all structural — `output` is the narrow `{ write }` shape
 * instead of the full `ChatOutput`, so `packages/core` does not depend on CLI types.
 */
export type ChildHostCallbacks = {
    readonly requestUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
    readonly requestUserQuestions?: (requests: readonly AskUserQuestionRequest[]) => Promise<string[]>;
    readonly emitEvent?: (event: AgentEvent) => void;
    readonly output?: {
        readonly write: (text: string) => void;
    };
    readonly onSignal?: (signal: AbgSignal) => void | Promise<void>;
    readonly onDurableEvent?: (event: AgentEvent) => void;
    readonly observabilityRedactor?: ObservabilityRedactor;
    /**
     * Optional parent-first answerer for child ask_user. When present, the child
     * routes through {@linkcode routeChildAskUser} before the user overlay.
     */
    readonly parentAskUserAnswerer?: ChildAskUserParentAnswerer;
    /**
     * Resolve per-child source metadata (agent name, category, title) for ask_user
     * overlay labeling. Called with the child session id at registration time.
     */
    readonly resolveChildAskUserSource?: (sessionId: string) => ChildAskUserSourceFields | undefined;
};

export type SpawnChildInput = {
    readonly description: string;
    readonly prompt: string;
    /** Resolves the child's model the same way the parent's is resolved. */
    readonly resolveSdkModel: (options: AbgNodeModelOptions) => LlmActorModel;
    readonly model: AbgNodeModelOptions;
    readonly now: () => string;
    readonly signal?: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
    /** Unique session id for the child run (caller-supplied for determinism/testability). */
    readonly sessionId: string;
    readonly summaryLimit?: number;
    /**
     * Pre-built child tool registry. The full-parity runtime supplies the result of
     * `buildChildToolSurface` (drops `task`/`job`, hard-drops orchestration/network classes,
     * adds `yield`, and enforces category plus path-policy rules at invocation time).
     */
    readonly childToolRegistry: ToolRegistry;
    /**
     * Child system prompt built from the agent body (delegation directive + role +
     * agent systemPrompt + parent context). When provided, it is injected into the
     * coding-agent graph's `llm-actor` node config so the child operates under its
     * OWN identity, not the generic parent persona.
     */
    readonly systemPrompt?: string;
    /**
     * Optional host-callback bag for routing child ask_user / events / signals back to the
     * parent TUI. When omitted the child runs isolated; ask_user returns the
     * `ASK_USER_BLOCKED_ANSWER` sentinel and events/signals are dropped at the child boundary.
     */
    readonly hostCallbacks?: ChildHostCallbacks;
};

/** Build + run the child graph and return its outcome as a `TaskOutput`. */
export async function spawnChildCodingAgent(input: SpawnChildInput): Promise<TaskOutput> {
    const childToolRegistry = input.childToolRegistry;
    if (childToolRegistry.advertise().some((tool) => tool.name === 'ask_user')) {
        registerChildAskUserTool(childToolRegistry, input.sessionId, input.hostCallbacks);
    }

    const graph = createCodingAgentGraph({
        model: input.model,
        requireYieldBeforeExit: true,
    });
    if (input.systemPrompt !== undefined) {
        const node = graph.nodes[0];
        if (node !== undefined) {
            node.config = { ...(node.config ?? {}), systemPrompt: input.systemPrompt };
        }
    }

    const result = await runAbgGraph({
        graph,
        sessionId: input.sessionId,
        now: input.now,
        modelProviderSelection: input.model,
        registry: createCodingAgentNodeRegistry(),
        resolveSdkModel: input.resolveSdkModel,
        toolRegistry: childToolRegistry,
        initialMessages: [{ role: 'user', content: input.prompt }],
        ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
        ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
        ...(input.hostCallbacks?.onSignal !== undefined ? { onSignal: input.hostCallbacks.onSignal } : {}),
        ...(input.hostCallbacks?.observabilityRedactor !== undefined
            ? { observabilityRedactor: input.hostCallbacks.observabilityRedactor }
            : {}),
    });

    const observabilityRedactor = input.hostCallbacks?.observabilityRedactor ?? createObservabilityRedactor();
    const summary = observabilityRedactor.redactText(
        latestAssistantText(result.finalMessages ?? [], input.summaryLimit ?? 4000),
    );
    return {
        description: input.description,
        status: result.status === 'completed' ? 'completed' : 'failed',
        summary,
    };
}

/**
 * Replace any ask_user registration on the child tool surface with one of two shapes:
 *  - When the host supplies a `requestUserQuestion` callback (parent TUI is attached), wrap it
 *    in a per-spawn mutex so concurrent child ask_user calls serialize through the host's
 *    single overlay slot. Parent-first routing stamps source metadata and may short-circuit
 *    via {@linkcode ChildHostCallbacks.parentAskUserAnswerer}.
 *  - When no host surface is attached (non-interactive hosts, pure-test paths), register the
 *    tool in non-interactive mode so it returns the {@linkcode ASK_USER_BLOCKED_ANSWER}
 *    sentinel instead of awaiting a callback that would never resolve and deadlocking the
 *    child graph.
 */
function registerChildAskUserTool(
    registry: ToolRegistry,
    sessionId: string,
    hostCallbacks: ChildHostCallbacks | undefined,
): void {
    const hostRequestUserQuestion = hostCallbacks?.requestUserQuestion;
    if (hostRequestUserQuestion !== undefined) {
        const sourceFields = hostCallbacks?.resolveChildAskUserSource?.(sessionId);
        const source = {
            sessionId,
            ...(sourceFields?.agentName !== undefined ? { agentName: sourceFields.agentName } : {}),
            ...(sourceFields?.category !== undefined ? { category: sourceFields.category } : {}),
            ...(sourceFields?.title !== undefined ? { title: sourceFields.title } : {}),
        };
        const parentAnswerer = hostCallbacks?.parentAskUserAnswerer;
        let lock: Promise<unknown> = Promise.resolve();
        const routed = async (request: AskUserQuestionRequest): Promise<string> => {
            const stamped = withChildAskUserSource(request, source);
            return routeChildAskUser({
                request: stamped,
                requestUserQuestion: hostRequestUserQuestion,
                ...(parentAnswerer !== undefined ? { parentAnswerer } : {}),
            });
        };
        const serialized = async (request: AskUserQuestionRequest): Promise<string> => {
            const next = lock.then(() => routed(request));
            // Swallow rejections on the lock so one failed prompt cannot wedge subsequent ones.
            lock = next.catch(() => undefined);
            return next;
        };
        const hostRequestUserQuestions = hostCallbacks?.requestUserQuestions;
        const batchCallback =
            parentAnswerer === undefined && hostRequestUserQuestions !== undefined
                ? async (requests: readonly AskUserQuestionRequest[]): Promise<string[]> => {
                      const stamped = requests.map((request) => {
                          const withSource = withChildAskUserSource(request, source);
                          const header = formatChildAskUserHeader(withSource);
                          return header !== undefined && header !== withSource.header
                              ? { ...withSource, header }
                              : withSource;
                      });
                      return hostRequestUserQuestions(stamped);
                  }
                : undefined;
        registry.register(
            createAskUserToolRegistration({
                requestUserQuestion: serialized,
                ...(batchCallback !== undefined ? { requestUserQuestions: batchCallback } : {}),
            }),
        );
        return;
    }
    // No parent overlay attached: surface the block via emitEvent if the host cares, then return
    // the deterministic sentinel. The child graph stays non-blocking and never deadlocks.
    const emitBlocked = hostCallbacks?.emitEvent;
    registry.register(
        createAskUserToolRegistration({
            requestUserQuestion: async () => ASK_USER_BLOCKED_ANSWER,
            nonInteractive: true,
            ...(emitBlocked !== undefined
                ? {
                      onAskBlocked: () => {
                          emitBlocked(blockedAskEvent(sessionId));
                      },
                  }
                : {}),
        }),
    );
}

export { registerChildAskUserTool };

function blockedAskEvent(sessionId: string): AgentEvent {
    return {
        type: 'tool.failed',
        timestamp: new Date().toISOString(),
        taskId: sessionId,
        message: `child ${sessionId}: ask_user blocked (no host surface)`,
        nativeSidecarStatus: 'mock',
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
