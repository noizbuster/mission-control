/**
 * Runner workflow E2E integration test (plan Task 3.13).
 *
 * Exercises the runner workflow graph structure end-to-end and runs the verification node
 * that backs the final verification wave (F1-F4):
 *   1. Load the runner WorkflowSpec from `examples/abg/runner.workflow.json`.
 *   2. Verify the graph has the three key structural landmarks:
 *      delegate-wave (task fan-out), per-task-verify (critic), final-verification-wave with
 *      children [f1, f2, f3, f4] (all critic implementation).
 *   3. Run the real `createVerificationNodeRunner()` with phase-result inputs and confirm
 *      it emits APPROVE when all phases pass and REJECT when one fails.
 *
 * This crosses three subsystems: workflow spec parsing, graph structure verification, and
 * actual node runner execution — none of which the unit tests exercise together.
 */
import { type AbgSignal, WorkflowSpecSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard.js';
import type { AbgNodeRunContext } from './node-registry.js';
import { createVerificationNodeRunner, type VerificationVerdict } from './nodes/verification-node.js';
import { readFile } from 'node:fs/promises';

const workflowJsonPath = `${process.cwd()}/examples/abg/runner.workflow.json`;

async function loadRunnerSpec() {
    const contents = await readFile(workflowJsonPath, 'utf8');
    const result = WorkflowSpecSchema.safeParse(JSON.parse(contents));
    if (!result.success) {
        throw new Error(`runner.workflow.json failed schema validation: ${result.error.message}`);
    }
    return result.data;
}

const NOW = '2026-06-22T00:00:00.000Z';

async function runVerificationNode(
    config: Record<string, unknown>,
): Promise<{ readonly verdict: VerificationVerdict | undefined; readonly emits: readonly AbgSignal[] }> {
    const runner = createVerificationNodeRunner();
    const blackboard = createBlackboard();
    const context: AbgNodeRunContext = { graphId: 'runner', now: () => NOW, blackboard };
    const node = { id: 'verify', kind: 'condition' as const, config };

    const collected: AbgSignal[] = [];
    for await (const signal of runner(node, context)) {
        collected.push(signal);
    }
    const success = collected.find((s): s is Extract<AbgSignal, { type: 'success' }> => s.type === 'success');
    const emits = collected.filter((s): s is Extract<AbgSignal, { type: 'emit' }> => s.type === 'emit');
    return { verdict: success?.result as VerificationVerdict | undefined, emits };
}

describe('runner workflow E2E: graph structure + verification node execution', () => {
    it('loads a valid runner WorkflowSpec with parse-plan entry node', async () => {
        const spec = await loadRunnerSpec();

        expect(spec.name).toBe('runner');
        expect(spec.graph.entryNodeId).toBe('parse-plan');
    });

    it('has a delegate-wave (parallel) that fans out to delegate-worker with task capability', async () => {
        const spec = await loadRunnerSpec();
        const graph = spec.graph;

        const delegateWave = graph.nodes.find((node) => node.id === 'delegate-wave');
        const delegateWorker = graph.nodes.find((node) => node.id === 'delegate-worker');

        expect(delegateWave?.kind).toBe('parallel');
        expect(delegateWave?.children).toContain('delegate-worker');
        expect(delegateWorker?.capabilities).toContain('task');
    });

    it('has a per-task-verify node with critic implementation', async () => {
        const spec = await loadRunnerSpec();
        const perTaskVerify = spec.graph.nodes.find((node) => node.id === 'per-task-verify');

        expect(perTaskVerify?.kind).toBe('llm');
        expect(perTaskVerify?.implementation).toBe('critic');
    });

    it('has a final-verification-wave with exactly four critic children (f1-f4)', async () => {
        const spec = await loadRunnerSpec();
        const graph = spec.graph;

        const finalWave = graph.nodes.find((node) => node.id === 'final-verification-wave');
        expect(finalWave?.kind).toBe('parallel');
        expect(finalWave?.children).toEqual(['f1', 'f2', 'f3', 'f4']);

        for (const criticId of ['f1', 'f2', 'f3', 'f4']) {
            const critic = graph.nodes.find((node) => node.id === criticId);
            expect(critic?.implementation).toBe('critic');
        }
    });

    it('verification node emits APPROVE when all four phases pass', async () => {
        const { verdict, emits } = await runVerificationNode({
            runAutomated: true,
            runReview: true,
            runQa: true,
            runDirectRead: true,
            automatedResult: { passed: true },
            reviewResult: { passed: true, findings: ['looks good'] },
            qaResult: { passed: true },
            directReadResult: { passed: true },
        });

        expect(verdict?.verdict).toBe('APPROVE');
        const evaluated = emits.find((signal) => 'event' in signal && signal.event.type === 'verification.evaluated');
        expect(evaluated).toBeDefined();
    });

    it('verification node emits REJECT when at least one phase fails', async () => {
        const { verdict } = await runVerificationNode({
            runAutomated: true,
            runReview: true,
            runQa: true,
            runDirectRead: true,
            automatedResult: { passed: true },
            reviewResult: { passed: false, findings: ['missing edge case'] },
            qaResult: { passed: true },
            directReadResult: { passed: true },
        });

        expect(verdict?.verdict).toBe('REJECT');
        expect(verdict?.findings).toContain('missing edge case');
    });
});
