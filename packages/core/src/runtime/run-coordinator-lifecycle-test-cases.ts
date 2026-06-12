import { expect, it } from 'vitest';
import { completedChunk, openCoordinatorContext, toolCallChunk } from './run-coordinator-lifecycle-test-support.js';

export function registerRunCoordinatorLifecycleTests(): void {
    it('records provider failure as run.failed', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_provider_failed');
        const coordinator = context.createCoordinator({
            async *streamTurn(request) {
                yield {
                    kind: 'response_failed',
                    requestId: request.requestId,
                    sequence: 1,
                    error: {
                        code: 'unknown',
                        message: 'provider exploded',
                        retryable: false,
                    },
                };
            },
        });
        await coordinator.steer({
            inputId: 'input_failed',
            messageId: 'message_failed',
            prompt: 'fail provider',
        });

        // When
        const result = await coordinator.wake();
        const events = await context.events();

        // Then
        expect(result).toMatchObject({
            status: 'failed',
            runId: 'run_1',
            turns: 1,
            reason: 'provider exploded',
            errorCode: 'unknown',
        });
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['run.failed']));
        expect(events.map((event) => event.type)).not.toContain('run.completed');
        expect(events.find((event) => event.type === 'run.failed')?.run).toMatchObject({
            state: 'failed',
            reason: 'provider exploded',
            errorCode: 'unknown',
        });
        await context.store.close();
    });

    it('projects blocked_on_approval while waiting for approval', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_approval_blocked');
        const coordinator = context.createCoordinator({
            async *streamTurn(request) {
                yield toolCallChunk(request, 'call_patch_pending', 'file.patch', {
                    patch: 'diff --git a/demo.txt b/demo.txt',
                });
                yield completedChunk(request, 'approval required', ['call_patch_pending']);
            },
        });
        await coordinator.steer({
            inputId: 'input_blocked',
            messageId: 'message_blocked',
            prompt: 'patch a file',
        });

        // When
        const result = await coordinator.wake();
        const events = await context.events();

        // Then
        expect(result).toMatchObject({
            status: 'blocked_on_approval',
            runId: 'run_1',
            turns: 1,
            toolCallId: 'call_patch_pending',
        });
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['run.blocked']));
        expect(events.map((event) => event.type)).not.toContain('run.completed');
        expect(events.find((event) => event.type === 'run.blocked')?.run).toMatchObject({
            state: 'blocked_on_approval',
            toolCallId: 'call_patch_pending',
            errorCode: 'tool_failed',
        });
        await context.store.close();
    });
}
