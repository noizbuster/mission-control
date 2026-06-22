/**
 * Phase 1 integration smoke test — Task 1.9.
 *
 * A single end-to-end scenario that wires all 7 Phase 1 runtime foundations:
 * protocol schemas (1.1) -> permission algebra (1.2) -> persistence (1.3) ->
 * mission/run store (1.4) -> steer/queue delivery + run coordinator (1.5) ->
 * system context (1.6) -> continuation runtime (1.7) -> task() tool (1.8).
 *
 * Each foundation is one step in one cohesive story:
 *   "A workflow is defined -> materialized as a Mission -> a Run starts ->
 *    the task tool delegates a sub-task -> the continuation runtime loops ->
 *    the run completes."
 */
// allow: SIZE_OK — integration smoke test; one cohesive scenario, splitting reduces clarity.

import { WorkflowSpecSchema } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    packSystemContextSource,
    SystemContextRegistry,
    stringContextCodec,
} from '../context/system-context-source.js';
import { assembleSystemPrompt } from '../context/system-prompt.js';
import { evaluateRules } from '../permissions/rule-evaluator.js';
import { type BoulderState, readBoulder, writeBoulder } from '../persistence/boulder-store.js';
import { parsePlanChecklist } from '../persistence/plan-store.js';
import {
    type ChildSpawnRequest,
    createFullParityTaskToolRegistration,
    type TaskToolRuntime,
    taskToolInputSchema,
} from '../tools/task/task-tool.js';
import type { ToolExecutionContext } from '../tools/tool-registry-types.js';
import { ContinuationRuntime } from './continuation/continuation-runtime.js';
import { completeRun, materializeMission, startRun } from './mission-run/mission-run-service.js';
import { createMission, readMission } from './mission-run/mission-store.js';
import { RunCoordinatorV2 } from './run-coordinator-v2.js';
import { SessionInputDelivery } from './session-input-delivery.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const WORK_ID = 'work-phase1-demo';

function makeBoulderState(workId: string): BoulderState {
    const now = new Date().toISOString();
    return {
        schema_version: 2,
        active_work_id: workId,
        works: {
            [workId]: {
                work_id: workId,
                active_plan: 'demo-plan',
                plan_name: 'Demo Plan',
                status: 'running',
                started_at: now,
                updated_at: now,
                session_ids: [],
                session_origins: {},
            },
        },
    };
}

function createRecordingRuntime(): { runtime: TaskToolRuntime; requests: ChildSpawnRequest[] } {
    const requests: ChildSpawnRequest[] = [];
    const runtime: TaskToolRuntime = {
        runChildSession: async (request) => {
            requests.push(request);
            return { sessionId: request.sessionId, status: 'completed', output: 'explored codebase' };
        },
        startBackgroundSession: (request) => ({ sessionId: request.sessionId, backgroundId: 'bg_demo' }),
        resumeChildSession: async (sessionId, request) => {
            requests.push(request);
            return { sessionId, status: 'completed', output: 'resumed' };
        },
        sessionExists: () => true,
        generateSessionId: () => 'ses_child_demo',
    };
    return { runtime, requests };
}

describe('Phase 1 integration: workflow lifecycle', () => {
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'phase1-int-'));
    });

    afterEach(() => {
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('exercises all 7 foundations in a single end-to-end scenario', async () => {
        // Step 1 — Define a workflow via protocol schemas (Task 1.1).
        const workflowSpec = WorkflowSpecSchema.parse({
            name: 'demo-workflow',
            description: 'Phase 1 integration scenario',
            graph: { id: 'demo-graph', entryNodeId: 'start', nodes: [{ id: 'start', kind: 'llm', label: 'Start' }] },
            categories: [{ id: 'build', permissions: ['read', 'edit', 'write', 'patch'] }],
            modes: [
                {
                    id: 'guarded',
                    policies: [
                        { action: 'write', resource: '**', effect: 'deny' },
                        { action: 'write', resource: '.omo/**', effect: 'allow' },
                    ],
                },
            ],
        });
        expect(workflowSpec.name).toBe('demo-workflow');

        // Step 2 — Evaluate the workflow mode's policy-gate rules (Task 1.2).
        const guardedPolicies = workflowSpec.modes?.[0]?.policies ?? [];
        const rulesets = [{ rules: guardedPolicies }];
        expect(evaluateRules('write', '.omo/plans/demo.md', rulesets).effect).toBe('allow');
        expect(evaluateRules('write', 'src/index.ts', rulesets).effect).toBe('deny');

        // Step 3 — Persist boulder state + parse a plan checklist (Task 1.3).
        await writeBoulder(tmpRoot, makeBoulderState(WORK_ID));
        expect((await readBoulder(tmpRoot))?.active_work_id).toBe(WORK_ID);

        const planPath = join(tmpRoot, '.omo', 'plans', 'demo.md');
        mkdirSync(dirname(planPath), { recursive: true });
        writeFileSync(planPath, '# Demo Plan\n\n- [ ] First step\n- [x] Second step\n- [ ] Third step\n');
        const checklist = await parsePlanChecklist(planPath);
        expect(checklist.total).toBe(3);
        expect(checklist.completed).toBe(1);

        // Step 4 — Materialize the workflow as a Mission and start a Run (Task 1.4).
        const mission = materializeMission(workflowSpec);
        await createMission(tmpRoot, mission);
        const run = await startRun(tmpRoot, mission.id, 'run the demo workflow');
        expect(run.status).toBe('running');
        expect((await readMission(tmpRoot, mission.id)).status).toBe('active');
        const sessionId = run.sessionId;
        if (sessionId === undefined) throw new Error('run has no session id');

        // Step 5 — Deliver a steer + queued input and coordinate a drain (Task 1.5).
        const delivery = new SessionInputDelivery();
        delivery.admitInput(sessionId, { inputId: 'in-1', prompt: 'refactor this' }, 'steer');
        delivery.admitInput(sessionId, { inputId: 'in-2', prompt: 'next task' }, 'queue');
        expect(delivery.pendingSteerCount(sessionId)).toBe(1);

        const coordinator = new RunCoordinatorV2({
            drain: async (key) => delivery.promoteSteers(key).length,
        });
        expect(await coordinator.run(sessionId)).toBe(1);
        expect(delivery.pendingSteerCount(sessionId)).toBe(0);
        expect(delivery.promoteNextQueued(sessionId)?.prompt).toBe('next task');

        // Step 6 — Register a context source and render the system prompt (Task 1.6).
        const registry = new SystemContextRegistry();
        registry.register(
            packSystemContextSource({
                key: 'boulder-status',
                codec: stringContextCodec,
                loader: async () => `Active work: ${WORK_ID} (running)`,
                baseline: (value) => `# Boulder\n${value}`,
                update: () => null,
            }),
        );
        const baseline = await registry.getBaselineText();
        const systemPrompt = assembleSystemPrompt({ contextBaseline: baseline, env: { modelId: 'test-model' } });
        expect(systemPrompt).toContain('Boulder');
        expect(systemPrompt).toContain(WORK_ID);

        // Step 7 — Run the continuation loop: 2 iterations then DONE (Task 1.7).
        let graphCalls = 0;
        const runGraphFn = async () => {
            graphCalls += 1;
            return graphCalls <= 2
                ? { loopActive: true, done: false, output: `iteration ${graphCalls}` }
                : { loopActive: false, done: true, output: 'workflow complete' };
        };
        const continuation = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const c1 = await continuation.runWithContinuation('ses-graph-1', runGraphFn);
        expect(c1.status).toBe('continue');
        const c2 = await continuation.runWithContinuation(
            c1.status === 'continue' ? c1.sessionId : 'ses-graph-2',
            runGraphFn,
        );
        expect(c2.status).toBe('continue');
        const c3 = await continuation.runWithContinuation(
            c2.status === 'continue' ? c2.sessionId : 'ses-graph-3',
            runGraphFn,
        );
        expect(c3.status).toBe('done');
        if (c3.status === 'done') expect(c3.reason).toBe('done_signal');
        expect(graphCalls).toBe(3);

        // Step 8 — Delegate a sub-task via the task() tool with category routing (Task 1.8).
        const { runtime, requests } = createRecordingRuntime();
        const taskTool = createFullParityTaskToolRegistration({ runtime });
        const ctx: ToolExecutionContext = {
            toolCallId: 'tc_phase1',
            toolName: 'task',
            signal: new AbortController().signal,
        };
        const taskResult = await taskTool.execute(
            taskToolInputSchema.parse({ prompt: 'explore the runtime', category: 'explore' }),
            ctx,
        );
        expect(taskResult.status).toBe('completed');
        expect(requests[0]?.category?.id).toBe('explore');
        // Permission derivation: nested-subagent deny is always injected for child sessions.
        expect(requests[0]?.childPermissions.some((r) => r.action === 'subagent' && r.effect === 'deny')).toBe(true);

        // Final — Complete the run and verify the full lifecycle settled.
        const completedRun = await completeRun(tmpRoot, run.id, { terminalReason: 'all foundations exercised' });
        expect(completedRun.status).toBe('completed');
        expect(completedRun.terminalReason).toBe('all foundations exercised');
        expect(completedRun.endedAt).toBeDefined();
    });
});
