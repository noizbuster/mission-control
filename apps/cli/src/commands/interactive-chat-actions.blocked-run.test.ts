import { AgentRuntime, createDeterministicProvider, type SdkModelResolver } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChatAction, startWorkflowTurn } from './interactive-chat-actions';
import {
    cleanupWorkflowFixtures,
    currentSelection,
    humanApprovalWorkflow,
    llmWorkflow,
    makeCodingContext,
    makeWorkflowFixture,
    readOnlyRun,
    runWorkflow,
} from './interactive-workflow-test-support';

afterEach(cleanupWorkflowFixtures);

describe('interactive workflow Run settlement persistence', () => {
    it('persists blocked from the production durable owner-event callback', async () => {
        const fixture = await makeWorkflowFixture('blocked', humanApprovalWorkflow());
        const result = await runWorkflow(fixture, createDeterministicProvider([]));
        await result.activeTurn?.done;
        expect(fixture.durableEvents.map((event) => event.type)).toContain('run.blocked');
        const run = await readOnlyRun(fixture);
        expect(run.status).toBe('blocked');
        expect(run.sessionId).toBe(fixture.sessionId);
        expect(run.terminalReason).toBeUndefined();
    });

    it('persists cancelled when production interruption is followed by synthetic task.failed', async () => {
        const fixture = await makeWorkflowFixture('interrupted', llmWorkflow());
        const result = await runWorkflow(
            fixture,
            createDeterministicProvider([
                { kind: 'wait', ms: 30_000 },
                { kind: 'response_completed', content: 'too late' },
            ]),
        );
        const activeTurn = result.activeTurn;
        if (activeTurn === undefined) throw new Error('expected active workflow turn');
        activeTurn.interrupt('force');
        await activeTurn.done;
        expect(fixture.durableEvents.map((event) => event.type)).toContain('run.interrupted');
        expect(fixture.emittedEvents).toContainEqual(
            expect.objectContaining({ type: 'task.failed', run: expect.objectContaining({ state: 'interrupted' }) }),
        );
        expect((await readOnlyRun(fixture)).status).toBe('cancelled');
    });

    it('preserves completed settlement from the production durable owner-event callback', async () => {
        const fixture = await makeWorkflowFixture('completed', llmWorkflow());
        const result = await runWorkflow(
            fixture,
            createDeterministicProvider([{ kind: 'response_completed', content: 'workflow complete' }]),
        );
        await result.activeTurn?.done;
        expect(fixture.durableEvents.map((event) => event.type)).toContain('run.completed');
        expect((await readOnlyRun(fixture)).status).toBe('completed');
    });

    it('preserves failed settlement from the production durable owner-event callback', async () => {
        const fixture = await makeWorkflowFixture('failed', llmWorkflow());
        const result = await runWorkflow(
            fixture,
            createDeterministicProvider([
                { kind: 'response_failed', error: { code: 'unknown', message: 'workflow failed', retryable: false } },
            ]),
        );
        await result.activeTurn?.done;
        expect(fixture.durableEvents.map((event) => event.type)).toContain('run.failed');
        expect((await readOnlyRun(fixture)).status).toBe('failed');
    });

    it('fails the durable Run when interactive owner setup rejects before returning a turn', async () => {
        const fixture = await makeWorkflowFixture('setup-failed', llmWorkflow());
        const rejectSetup: SdkModelResolver = () => {
            throw new Error('resolver setup failed with sk-test-secret-token');
        };
        await expect(runWorkflow(fixture, createDeterministicProvider([]), rejectSetup)).rejects.toThrow(
            'resolver setup failed with [REDACTED_CREDENTIAL]',
        );
        const run = await readOnlyRun(fixture);
        expect(run.status).toBe('failed');
        expect(run.terminalReason).toBe('workflow turn setup failed');
    });

    it('fails the durable Run when owner submission rejects before run.started', async () => {
        const fixture = await makeWorkflowFixture('submit-failed', llmWorkflow());
        const coding = await makeCodingContext(fixture, createDeterministicProvider([]));
        const sessionStore = coding.sessionStore;
        if (sessionStore === undefined) throw new Error('expected durable session store');
        vi.spyOn(sessionStore, 'append').mockRejectedValueOnce(new Error('owner submit failed'));
        const result = await runChatAction(
            new AgentRuntime(),
            { write: () => undefined },
            { kind: 'workflow', name: fixture.spec.name, prompt: 'run workflow' },
            currentSelection,
            async () => undefined,
            [],
            coding,
        );
        await result.activeTurn?.done;
        const run = await readOnlyRun(fixture);
        expect(run.status).toBe('failed');
        expect(run.terminalReason).toBe('workflow turn settled without a terminal event');
    });

    it('tracks workflows started through the model workflow tool', async () => {
        const fixture = await makeWorkflowFixture('tool-started', llmWorkflow());
        const coding = await makeCodingContext(
            fixture,
            createDeterministicProvider([{ kind: 'response_completed', content: 'workflow complete' }]),
        );
        const result = await startWorkflowTurn(
            new AgentRuntime(),
            { write: () => undefined },
            fixture.spec,
            'run from tool',
            currentSelection,
            coding,
        );
        await result.activeTurn?.done;
        const run = await readOnlyRun(fixture);
        expect(run.status).toBe('completed');
        expect(run.prompt).toBe('run from tool');
    });
});
