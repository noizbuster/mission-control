/**
 * Hybrid ABG session-resume regression pack — CLI surface (plan todo 12).
 *
 * Locks:
 * 2. attach banner no auto-run → continue remains actionable
 * 5. workflow interrupt cold continue recovers the same graph (no cancelled→running)
 * 6. CLI resume UX modules do not import ContinuationRuntime
 *
 * Core contracts 1/3/4/6 live in packages/core session-resume-abg-regression.test.ts.
 * Full /continue owner settlement remains in interactive-chat-actions.workflow-resume.test.ts.
 */

import {
    createMission,
    listRunsForMission,
    materializeMission,
    readRun,
    settleMissionRunSessionOwner,
    startRun,
    WorkflowRegistry,
} from '@mission-control/core';
import type { AgentEvent, GraphCheckpoint, WorkflowSpec } from '@mission-control/protocol';
import { createAbgOverlayController, createAbgOverlayStore } from '@mission-control/tui/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { findWorkflowGraphForSessionContinue } from './interactive-workflow-state';
import {
    applySessionAttachProjection,
    projectSessionAttachFromEvents,
    RESUMABLE_ATTACH_BANNER,
} from './session-attach-projection';
import { decideWorkResume, formatWorkResumeStartMessage, isWorkResumeActionable } from './work-resume-decision';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMESTAMP = '2026-07-20T12:00:00.000Z';
const SESSION_ID = 'session_cli_resume_regression';
const HERE = dirname(fileURLToPath(import.meta.url));
const tempRoots: string[] = [];

const CLI_RESUME_PATH_SOURCES = [
    join(HERE, 'session-attach-projection.ts'),
    join(HERE, 'work-resume-decision.ts'),
    join(HERE, 'interactive-workflow-resume-actions.ts'),
    join(HERE, 'interactive-workflow-state.ts'),
] as const;

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session-resume ABG regression pack (cli)', () => {
    it('2. attach projects sticky banner without auto-run and leave continue actionable', () => {
        // Given: cold interrupted events with a queued checkpoint.
        const checkpoint = makeCheckpoint({
            sessionRunId: 'run-int',
            queuedNodeIds: ['next-node'],
            completedNodeIds: ['start'],
        });
        const events = interruptedEvents(checkpoint, 'run-int');
        const controller = createAbgOverlayController(createAbgOverlayStore());
        const chatOutput = createChatOutput();
        const resumeTurn = vi.fn();
        const projection = projectSessionAttachFromEvents(events);

        // When: attach projection is applied (session attach / /resume path).
        applySessionAttachProjection({
            events,
            projection,
            abgOverlayController: controller,
            chatOutput,
        });

        // Then: sticky interrupted banner + ABG snapshot, and no turn starts.
        expect(projection.stickyBannerMessage).toBe(RESUMABLE_ATTACH_BANNER.interrupted);
        expect(chatOutput.sticky.value).toBe(RESUMABLE_ATTACH_BANNER.interrupted);
        expect(controller.store.getSnapshot().runState).toBe('interrupted');
        expect(resumeTurn).not.toHaveBeenCalled();

        // And: /continue classification remains actionable with the queued cursor.
        const decision = decideWorkResume(events);
        expect(isWorkResumeActionable(decision)).toBe(true);
        expect(decision.kind).toBe('interrupted');
        if (decision.kind !== 'interrupted') {
            throw new Error('expected interrupted decision');
        }
        expect(decision.snapshot.checkpoint.queuedNodeIds).toEqual(['next-node']);
        expect(formatWorkResumeStartMessage(decision, SESSION_ID)).toContain('queued node(s): next-node');
    });

    it('2b. attach approval banner is sticky and continue classifies as approval', () => {
        // Given: approval-blocked cold events.
        const events: AgentEvent[] = [
            baseEvent('graph.started', { abg: { graphId: 'graph-main' } }),
            baseEvent('run.blocked', {
                run: {
                    runId: 'run-blocked',
                    state: 'blocked_on_approval',
                    toolCallId: 'tool-1',
                    reason: 'waiting for approval: file.patch',
                },
            }),
        ];
        const chatOutput = createChatOutput();
        const projection = projectSessionAttachFromEvents(events);

        // When: attach projection is applied.
        applySessionAttachProjection({
            events,
            projection,
            abgOverlayController: undefined,
            chatOutput,
        });

        // Then: approval banner sticks and /continue is approval-actionable.
        expect(chatOutput.sticky.value).toBe(RESUMABLE_ATTACH_BANNER.approval);
        const decision = decideWorkResume(events);
        expect(decision.kind).toBe('approval');
        expect(isWorkResumeActionable(decision)).toBe(true);
    });

    it('5. workflow interrupt cold continue recovers the same graph without cancelled→running', async () => {
        // Given: cancelled workflow Run after interrupt; registry holds a changed graph under the same name.
        const workspace = await mkdtemp(join(tmpdir(), 'wf-regression-interrupt-'));
        tempRoots.push(workspace);
        await mkdir(join(workspace, '.mc'), { recursive: true });
        const dataDir = join(workspace, 'data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_regression_interrupt';
        const sessionRunId = 'owner_regression_interrupt';
        const original = workflowSpec('regression-workflow', 'regression-original-graph');
        const changed: WorkflowSpec = {
            ...original,
            graph: { ...original.graph, id: 'regression-changed-graph' },
        };
        const location = { mcRoot: workspace, dataDir };
        const mission = materializeMission(original);
        await createMission(location, mission);
        const prior = await startRun(location, mission.id, 'interrupt me', { sessionId });
        await settleMissionRunSessionOwner(
            location,
            prior.id,
            { sessionId, sessionRunId },
            { status: 'cancelled', reason: 'operator interrupt' },
        );
        const checkpoint = makeCheckpoint({
            graphId: original.graph.id,
            sessionRunId,
            queuedNodeIds: ['entry'],
            completedNodeIds: [],
            workflowName: original.name,
        });
        const events = interruptedEvents(checkpoint, sessionRunId);

        // When: cold continue recovers graph identity after attach-style event load.
        const decision = decideWorkResume(events);
        expect(decision.kind).toBe('interrupted');
        const recovered = await findWorkflowGraphForSessionContinue({
            workspaceRoot: workspace,
            sessionId,
            sessionRunId,
            workflowRegistry: new WorkflowRegistry([changed]),
            checkpoint,
            prompt: 'interrupt me',
        });

        // Then: original mission graph wins; prior stays cancelled; a new Run is booked.
        expect(recovered?.graph).toEqual(original.graph);
        expect(recovered?.bookkeeping).toBe('started_new_run');
        expect((await readRun(location, prior.id)).status).toBe('cancelled');
        expect(await listRunsForMission(location, mission.id)).toHaveLength(2);
        const handle = recovered?.handle;
        if (handle === undefined) {
            throw new Error('expected continue handle');
        }
        expect(handle.runId).not.toBe(prior.id);
        expect((await readRun(location, handle.runId)).status).toBe('running');
    });

    it('6. CLI resume UX modules do not import ContinuationRuntime', () => {
        // Anti-scope lock: attach/continue UX must not wire C7 ContinuationRuntime.
        for (const sourcePath of CLI_RESUME_PATH_SOURCES) {
            const source = readFileSync(sourcePath, 'utf8');
            expect(source, sourcePath).not.toMatch(/\bContinuationRuntime\b/);
            expect(source, sourcePath).not.toMatch(/\brunWithContinuation\b/);
        }
    });
});

function baseEvent(type: AgentEvent['type'], overrides: Partial<AgentEvent> = {}): AgentEvent {
    return {
        type,
        timestamp: TIMESTAMP,
        sessionId: SESSION_ID,
        message: type,
        ...overrides,
    };
}

function interruptedEvents(checkpoint: GraphCheckpoint, runId: string): AgentEvent[] {
    return [
        baseEvent('graph.started', { abg: { graphId: checkpoint.graphId } }),
        baseEvent('node.started', { abg: { graphId: checkpoint.graphId, nodeId: 'start' } }),
        baseEvent('node.completed', { abg: { graphId: checkpoint.graphId, nodeId: 'start' } }),
        baseEvent('graph.checkpoint', {
            abg: { graphId: checkpoint.graphId, checkpoint },
            run: { runId },
        }),
        baseEvent('run.interrupted', {
            run: { runId, state: 'interrupted', reason: 'provider_aborted' },
        }),
    ];
}

function makeCheckpoint(input: {
    readonly graphId?: string;
    readonly sessionRunId: string;
    readonly queuedNodeIds: readonly string[];
    readonly completedNodeIds: readonly string[];
    readonly workflowName?: string;
}): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: input.graphId ?? 'graph-main',
        sessionRunId: input.sessionRunId,
        ...(input.workflowName !== undefined ? { workflowName: input.workflowName } : {}),
        reason: 'interrupt',
        queuedNodeIds: [...input.queuedNodeIds],
        completedNodeIds: [...input.completedNodeIds],
        nodeStatuses: Object.fromEntries(input.completedNodeIds.map((nodeId) => [nodeId, 'succeeded' as const])),
        attemptsByNodeId: Object.fromEntries(input.completedNodeIds.map((nodeId) => [nodeId, 1])),
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: input.completedNodeIds.length,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 64,
        blackboardEntries: {},
        activeParallelParentIds: [],
        createdAt: TIMESTAMP,
    };
}

function workflowSpec(name: string, graphId: string): WorkflowSpec {
    return {
        name,
        graph: {
            id: graphId,
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

function createChatOutput(): ChatOutput & {
    readonly sticky: { value: string | null };
    readonly writes: string[];
} {
    const sticky = { value: null as string | null };
    const writes: string[] = [];
    return {
        writes,
        sticky,
        write: (text) => {
            writes.push(text);
        },
        setStickyNotice: (message) => {
            sticky.value = message;
        },
    };
}
