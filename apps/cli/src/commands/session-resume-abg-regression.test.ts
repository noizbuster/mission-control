import {
    createMission,
    listRunsForMission,
    materializeMission,
    readRun,
    settleMissionRunSessionOwner,
    startRun,
    WorkflowRegistry,
} from '@mission-control/core';
import type { WorkflowSpec } from '@mission-control/protocol';
import { createAbgOverlayController, createAbgOverlayStore } from '@mission-control/tui/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findWorkflowGraphForSessionContinue } from './interactive-workflow-state';
import {
    applySessionAttachProjection,
    projectSessionAttachFromEvents,
    RESUMABLE_ATTACH_BANNER,
} from './session-attach-projection';
import {
    baseEvent,
    CLI_RESUME_REGRESSION_SESSION_ID,
    createChatOutput,
    interruptedEvents,
    makeCheckpoint,
    readCliResumePathSourceTexts,
    workflowSpec,
} from './session-resume-abg-regression-test-support';
import { decideWorkResume, formatWorkResumeStartMessage, isWorkResumeActionable } from './work-resume-decision';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

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
        expect(formatWorkResumeStartMessage(decision, CLI_RESUME_REGRESSION_SESSION_ID)).toContain(
            'queued node(s): next-node',
        );
    });

    it('2b. attach approval banner is sticky and continue classifies as approval', () => {
        // Given: approval-blocked cold events.
        const events = [
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
        // Given: attach/continue UX source modules.
        for (const { sourcePath, source } of readCliResumePathSourceTexts()) {
            // Then: attach/continue UX must not wire C7 ContinuationRuntime.
            expect(source, sourcePath).not.toMatch(/\bContinuationRuntime\b/);
            expect(source, sourcePath).not.toMatch(/\brunWithContinuation\b/);
        }
    });
});
