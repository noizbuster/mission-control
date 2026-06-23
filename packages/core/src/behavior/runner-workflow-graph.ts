/**
 * The runner workflow graph: executes a plan produced by the planner workflow
 * (plan Task 3.4, ABG Round 8 decomposition).
 *
 *   parse-plan -> init-notepad -> next-wave -> {
 *     wave-pending    -> delegate-wave -> per-task-verify -> checkbox-update -> next-wave (loop)
 *     all-tasks-done  -> final-verification-wave -> {
 *                          final-approved -> complete
 *                        | final-rejected -> fix-loop -> next-wave (retry)
 *                        }
 *   }
 *
 * The runner parses a plan checklist, delegates waves of tasks via `task()` fan-out, verifies each
 * delegation result through a per-task critic, updates plan checkboxes, and loops until all tasks
 * are checked. It then runs a final verification wave with four parallel critics (F1-F4) that each
 * evaluate a distinct aspect (goal, constraints, tests, code quality) and produce APPROVE/REJECT.
 * The parallel node aggregates their verdicts into `final.verdict`; if any critic rejects, the
 * fix-loop node reopens the relevant tasks and routes back to `next-wave`.
 *
 * All routing uses `blackboard.value.equals` on per-node `outputKey`s, mirroring the default
 * workflow's precise, engine-agnostic declarative routing.
 */
import type { AbgGraphSpec, AbgNodeModelOptions } from '@mission-control/protocol';

export const RUNNER_WORKFLOW_GRAPH_ID = 'runner';
export const RUNNER_WORKFLOW_MAX_NODE_RUNS = 64;

export type RunnerWorkflowGraphOptions = {
    /**
     * Provider/model pin for the graph's `defaults.model`. When omitted, the graph does NOT
     * declare a default model; the runtime resolves each LLM node's model from the session's
     * `modelProviderSelection` (the logged-in provider) at `runContext` time. Pass an explicit
     * model only when a graph should override the session provider.
     */
    readonly model?: AbgNodeModelOptions;
    /** Graph loop bound. Default 64. */
    readonly maxNodeRuns?: number;
};

export function createRunnerWorkflowGraph(options: RunnerWorkflowGraphOptions = {}): AbgGraphSpec {
    return {
        id: RUNNER_WORKFLOW_GRAPH_ID,
        version: '0.1.0',
        entryNodeId: 'parse-plan',
        defaults: {
            ...(options.model !== undefined ? { model: options.model } : {}),
            maxNodeRuns: options.maxNodeRuns ?? RUNNER_WORKFLOW_MAX_NODE_RUNS,
        },
        nodes: [
            {
                id: 'parse-plan',
                kind: 'llm',
                label: 'Parse plan checklist from .omo/plans/',
                config: {
                    systemPrompt:
                        'Read the plan file from .omo/plans/, parse the markdown checklist into ordered tasks, and store them. Set plan.parsed when complete.',
                    outputKey: 'plan.parsed',
                },
            },
            {
                id: 'init-notepad',
                kind: 'llm',
                label: 'Initialize append-only notepad for this run',
                config: {
                    systemPrompt:
                        'Initialize the append-only notepad at .omo/notepads/{plan}/learnings.md for this run. Set notepad.ready when complete.',
                    outputKey: 'notepad.ready',
                },
            },
            {
                id: 'next-wave',
                kind: 'llm',
                label: 'Select next wave of unchecked tasks or signal completion',
                config: {
                    systemPrompt:
                        'Inspect the plan checklist. If unchecked tasks remain, select the next wave and set wave.pending=true. If all tasks are checked, set wave.pending=false.',
                    outputKey: 'wave.pending',
                },
            },
            {
                id: 'delegate-wave',
                kind: 'parallel',
                label: 'Fan out task() delegation per wave task',
                children: ['delegate-worker'],
                config: { fanOutKey: 'wave.tasks', completionKey: 'delegate.complete' },
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
                id: 'per-task-verify',
                kind: 'llm',
                implementation: 'critic',
                label: 'Critic — verify each delegated task result',
                config: { evaluateKey: 'delegate.results', outputKey: 'verify.complete' },
            },
            {
                id: 'checkbox-update',
                kind: 'llm',
                label: 'Update plan checkboxes from verification results',
                config: {
                    systemPrompt:
                        'Update the plan markdown checkboxes based on per-task verification. Set checkbox.updated when complete.',
                    outputKey: 'checkbox.updated',
                },
            },
            {
                id: 'final-verification-wave',
                kind: 'parallel',
                label: 'Final verification wave — F1-F4 parallel critics',
                children: ['f1', 'f2', 'f3', 'f4'],
                config: { completionKey: 'final.verdict' },
            },
            {
                id: 'f1',
                kind: 'llm',
                implementation: 'critic',
                label: 'F1 — Goal verification critic',
                config: {
                    systemPrompt:
                        'F1: Verify the implementation achieves the plan stated goal. Output APPROVE or REJECT.',
                    evaluateKey: 'plan.goal',
                    outputKey: 'final.f1',
                },
            },
            {
                id: 'f2',
                kind: 'llm',
                implementation: 'critic',
                label: 'F2 — Constraint verification critic',
                config: {
                    systemPrompt: 'F2: Verify all explicit constraints were honored. Output APPROVE or REJECT.',
                    evaluateKey: 'plan.constraints',
                    outputKey: 'final.f2',
                },
            },
            {
                id: 'f3',
                kind: 'llm',
                implementation: 'critic',
                label: 'F3 — Test verification critic',
                config: {
                    systemPrompt: 'F3: Verify all tests pass. Output APPROVE or REJECT.',
                    evaluateKey: 'test.results',
                    outputKey: 'final.f3',
                },
            },
            {
                id: 'f4',
                kind: 'llm',
                implementation: 'critic',
                label: 'F4 — Code quality verification critic',
                config: {
                    systemPrompt: 'F4: Verify the code is clean and well-structured. Output APPROVE or REJECT.',
                    evaluateKey: 'code.quality',
                    outputKey: 'final.f4',
                },
            },
            {
                id: 'complete',
                kind: 'llm',
                label: 'All verification passed — emit final report',
            },
            {
                id: 'fix-loop',
                kind: 'llm',
                label: 'Final verification failed — reopen tasks and retry',
                config: {
                    systemPrompt:
                        'Analyze the rejected aspects, reopen relevant plan tasks, and set fix.retry to route back to next-wave.',
                    outputKey: 'fix.retry',
                },
            },
        ],
        edges: [
            { source: 'parse-plan', target: 'init-notepad', condition: 'plan-parsed', priority: 10 },
            { source: 'init-notepad', target: 'next-wave', condition: 'notepad-ready', priority: 10 },
            { source: 'next-wave', target: 'delegate-wave', condition: 'wave-pending', priority: 20 },
            { source: 'next-wave', target: 'final-verification-wave', condition: 'all-tasks-done', priority: 10 },
            { source: 'delegate-wave', target: 'per-task-verify', condition: 'delegate-complete', priority: 10 },
            { source: 'per-task-verify', target: 'checkbox-update', condition: 'verify-done', priority: 10 },
            { source: 'checkbox-update', target: 'next-wave', condition: 'checkbox-updated', priority: 10 },
            { source: 'final-verification-wave', target: 'complete', condition: 'final-approved', priority: 20 },
            { source: 'final-verification-wave', target: 'fix-loop', condition: 'final-rejected', priority: 10 },
            { source: 'fix-loop', target: 'next-wave', condition: 'fix-retry', priority: 10 },
        ],
        rules: [
            {
                id: 'llm-loop-active',
                description: 'LLM node re-enters while it proposes tool calls',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
            {
                id: 'plan-parsed',
                description: 'plan parsed successfully',
                when: { kind: 'blackboard.key.exists', key: 'plan.parsed' },
            },
            {
                id: 'notepad-ready',
                description: 'notepad initialized',
                when: { kind: 'blackboard.key.exists', key: 'notepad.ready' },
            },
            {
                id: 'wave-pending',
                description: 'unchecked tasks remain in the plan',
                when: { kind: 'blackboard.value.equals', key: 'wave.pending', value: true },
            },
            {
                id: 'all-tasks-done',
                description: 'all plan tasks checked',
                when: { kind: 'blackboard.value.equals', key: 'wave.pending', value: false },
            },
            {
                id: 'delegate-complete',
                description: 'delegation wave finished',
                when: { kind: 'blackboard.value.equals', key: 'delegate.complete', value: true },
            },
            {
                id: 'verify-done',
                description: 'per-task verification complete',
                when: { kind: 'blackboard.key.exists', key: 'verify.complete' },
            },
            {
                id: 'checkbox-updated',
                description: 'plan checkboxes updated',
                when: { kind: 'blackboard.key.exists', key: 'checkbox.updated' },
            },
            {
                id: 'final-approved',
                description: 'all final critics approved',
                when: { kind: 'blackboard.value.equals', key: 'final.verdict', value: 'APPROVE' },
            },
            {
                id: 'final-rejected',
                description: 'at least one final critic rejected',
                when: { kind: 'blackboard.value.equals', key: 'final.verdict', value: 'REJECT' },
            },
            {
                id: 'fix-retry',
                description: 'fix-loop reopening tasks',
                when: { kind: 'blackboard.value.equals', key: 'fix.retry', value: true },
            },
        ],
        policies: [],
    };
}
