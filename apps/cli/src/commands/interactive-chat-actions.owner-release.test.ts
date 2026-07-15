import { AgentRuntime, createDeterministicProvider } from '@mission-control/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runChatAction } from './interactive-chat-actions';
import {
    cleanupWorkflowFixtures,
    currentSelection,
    humanApprovalWorkflow,
    makeCodingContext,
    makeWorkflowFixture,
    readOnlyRun,
} from './interactive-workflow-test-support';
import { MissionControlServices } from './mission-control-services';

describe('interactive blocked workflow owner release', () => {
    afterEach(cleanupWorkflowFixtures);

    it('releases the blocked owner before /continue attaches a replacement owner', async () => {
        const fixture = await makeWorkflowFixture('owner-release', humanApprovalWorkflow());
        const services = await MissionControlServices.create(fixture.workspace);
        try {
            const coding = {
                ...(await makeCodingContext(fixture, createDeterministicProvider([]))),
                taskRuntimeServices: services.getTaskRuntimeServices(),
            };
            const initial = await runChatAction(
                new AgentRuntime(),
                { write: () => undefined },
                { kind: 'workflow', name: fixture.spec.name, prompt: 'block then resume' },
                currentSelection,
                async () => undefined,
                [],
                coding,
            );
            await initial.activeTurn?.done;
            const resumed = await runChatAction(
                new AgentRuntime(),
                { write: () => undefined },
                { kind: 'continue' },
                currentSelection,
                async () => undefined,
                [],
                coding,
            );
            await resumed.activeTurn?.done;
            expect(resumed.activeTurn).toBeDefined();
            expect((await readOnlyRun(fixture)).status).toBe('blocked');
        } finally {
            await services.dispose();
        }
    });
});
