/**
 * The default workflow graph: the no-`#` fallback that replaces the coding-agent graph as
 * the default prompt path (plan Task 2.5, ABG Round 8 decomposition).
 *
 *   intent-gate -> {
 *     trivial     -> direct-respond (llm self-loop)
 *     explicit    -> memory -> todo-plan -> delegate-wave -> verify-wave -> {
 *                       critic-passed -> final-respond
 *                     | critic-failed -> supervisor -> delegate-wave (retry)
 *                   }
 *     ambiguous   -> clarify -> intent-gate (re-classify)
 *   }
 *
 * Intent classification, todo planning, delegation (task() fan-out via `parallel`), critic
 * verification, supervisor retry, and clarification are LLM-driven nodes using the existing
 * coding-agent node registry (`llm`, `memory`, `parallel` + `critic`/`supervisor` via
 * `implementation`). The graph is declarative: each node's `config.outputKey` declares which
 * blackboard key the Phase 3 node implementation sets, and every edge is gated by a
 * `blackboard.value.equals` rule on that key. This keeps routing precise (no global
 * `signal.type.equals` fan-out) and the definition engine-agnostic.
 *
 * The old `createCodingAgentGraph` in `coding-agent-graph.ts` is KEPT for fixture compatibility
 * (`examples/abg/coding-agent.graph.json`); this factory is the new no-`#` default.
 */
import type { AbgGraphSpec, AbgNodeModelOptions } from '@mission-control/protocol';

export const DEFAULT_WORKFLOW_GRAPH_ID = 'default';
export const DEFAULT_WORKFLOW_MAX_NODE_RUNS = 48;

export type DefaultWorkflowGraphOptions = {
    /**
     * Provider/model pin for the graph's `defaults.model`. When omitted, the graph does NOT
     * declare a default model; the runtime resolves each LLM node's model from the session's
     * `modelProviderSelection` (the logged-in provider) at `runContext` time. Pass an explicit
     * model only when a graph should override the session provider.
     */
    readonly model?: AbgNodeModelOptions;
    /** Graph loop bound. Default 48. */
    readonly maxNodeRuns?: number;
};

export function createDefaultWorkflowGraph(options: DefaultWorkflowGraphOptions = {}): AbgGraphSpec {
    return {
        id: DEFAULT_WORKFLOW_GRAPH_ID,
        version: '0.1.0',
        entryNodeId: 'intent-gate',
        defaults: {
            ...(options.model !== undefined ? { model: options.model } : {}),
            maxNodeRuns: options.maxNodeRuns ?? DEFAULT_WORKFLOW_MAX_NODE_RUNS,
        },
        nodes: [
            {
                id: 'intent-gate',
                kind: 'llm',
                label: 'Intent classification — trivial | explicit | ambiguous',
                config: {
                    systemPrompt:
                        'Classify the user prompt into exactly one category. Respond with ONLY the category name, nothing else.\n\n- trivial: A greeting, simple question, or single-turn answer that needs no tools or file changes.\n- explicit: A coding task, file edit, project setup, or multi-step request that requires tools.\n- ambiguous: A request too vague to act on without clarification.',
                    outputKey: 'intent.classification',
                },
            },
            {
                id: 'direct-respond',
                kind: 'llm',
                label: 'Direct response — trivial prompts',
            },
            {
                id: 'memory',
                kind: 'memory',
                label: 'Recall relevant session context',
                config: { op: 'set', key: 'memory.loaded', value: true },
            },
            {
                id: 'todo-plan',
                kind: 'llm',
                label: 'Decompose explicit task into ordered todos',
                config: {
                    systemPrompt:
                        'Break the task into small ordered todo items. Store the list in plan.todos and set plan.ready when complete.',
                    outputKey: 'plan.ready',
                },
            },
            {
                id: 'delegate-wave',
                kind: 'parallel',
                label: 'Fan out task() delegation per todo',
                children: ['delegate-worker'],
                config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
            },
            {
                id: 'delegate-worker',
                kind: 'llm',
                label: 'Single task() delegation',
                capabilities: ['task'],
                config: {
                    systemPrompt: 'Execute the delegated sub-task via the task tool.',
                },
            },
            {
                id: 'verify-wave',
                kind: 'llm',
                implementation: 'critic',
                label: 'Critic — verify delegate results',
                config: { evaluateKey: 'delegate.results', outputKey: 'critic.passed' },
            },
            {
                id: 'supervisor',
                kind: 'llm',
                implementation: 'supervisor',
                label: 'Retry or escalate on critic failure',
                config: { maxAttempts: 2 },
            },
            {
                id: 'final-respond',
                kind: 'llm',
                label: 'Synthesize final answer from verified results',
            },
            {
                id: 'clarify',
                kind: 'llm',
                label: 'Ask clarifying questions — ambiguous prompts',
                config: {
                    systemPrompt:
                        'Ask the user targeted clarifying questions. Set clarify.active when clarification is collected.',
                    outputKey: 'clarify.active',
                },
            },
        ],
        edges: [
            { source: 'intent-gate', target: 'direct-respond', condition: 'intent-trivial', priority: 30 },
            { source: 'intent-gate', target: 'memory', condition: 'intent-explicit', priority: 20 },
            { source: 'intent-gate', target: 'clarify', condition: 'intent-ambiguous', priority: 10 },
            { source: 'intent-gate', target: 'intent-gate', condition: 'llm-loop-active', priority: 5 },
            { source: 'direct-respond', target: 'direct-respond', condition: 'llm-loop-active', priority: 10 },
            { source: 'memory', target: 'todo-plan', condition: 'memory-loaded', priority: 10 },
            { source: 'todo-plan', target: 'delegate-wave', condition: 'plan-ready', priority: 10 },
            { source: 'todo-plan', target: 'todo-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'delegate-wave', target: 'verify-wave', condition: 'wave-complete', priority: 10 },
            { source: 'delegate-worker', target: 'delegate-worker', condition: 'llm-loop-active', priority: 5 },
            { source: 'verify-wave', target: 'final-respond', condition: 'critic-passed', priority: 20 },
            { source: 'verify-wave', target: 'supervisor', condition: 'critic-failed', priority: 10 },
            { source: 'supervisor', target: 'delegate-wave', condition: 'supervisor-retry', priority: 10 },
            { source: 'supervisor', target: 'final-respond', condition: 'supervisor-escalated', priority: 20 },
            { source: 'final-respond', target: 'final-respond', condition: 'llm-loop-active', priority: 5 },
            { source: 'clarify', target: 'intent-gate', condition: 'clarify-loop', priority: 10 },
            { source: 'clarify', target: 'clarify', condition: 'llm-loop-active', priority: 5 },
        ],
        rules: [
            {
                id: 'intent-trivial',
                description: 'intent classified as trivial',
                when: { kind: 'blackboard.value.equals', key: 'intent.classification', value: 'trivial' },
            },
            {
                id: 'intent-explicit',
                description: 'intent classified as explicit',
                when: { kind: 'blackboard.value.equals', key: 'intent.classification', value: 'explicit' },
            },
            {
                id: 'intent-ambiguous',
                description: 'intent classified as ambiguous',
                when: { kind: 'blackboard.value.equals', key: 'intent.classification', value: 'ambiguous' },
            },
            {
                id: 'llm-loop-active',
                description: 'direct-respond re-enters while it proposes tool calls',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
            {
                id: 'memory-loaded',
                description: 'context memory loaded',
                when: { kind: 'blackboard.value.equals', key: 'memory.loaded', value: true },
            },
            {
                id: 'plan-ready',
                description: 'todo plan produced',
                when: { kind: 'blackboard.key.exists', key: 'plan.ready' },
            },
            {
                id: 'wave-complete',
                description: 'delegation wave finished',
                when: { kind: 'blackboard.key.exists', key: 'delegate.complete' },
            },
            {
                id: 'critic-passed',
                description: 'verify-wave critic approved results',
                when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: true },
            },
            {
                id: 'critic-failed',
                description: 'verify-wave critic rejected results',
                when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: false },
            },
            {
                id: 'supervisor-retry',
                description: 'supervisor decided to retry delegation',
                when: { kind: 'blackboard.value.equals', key: 'supervisor.action', value: 'retry' },
            },
            {
                id: 'supervisor-escalated',
                description: 'supervisor escalated after exhausting retries',
                when: { kind: 'blackboard.key.exists', key: 'supervisor.escalated' },
            },
            {
                id: 'clarify-loop',
                description: 'clarification collected — re-classify intent',
                when: { kind: 'blackboard.value.equals', key: 'clarify.active', value: true },
            },
        ],
        policies: [],
    };
}
