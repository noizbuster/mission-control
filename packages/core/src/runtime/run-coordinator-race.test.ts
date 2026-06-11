import { afterEach, describe, expect, it } from 'vitest';
import { projectSessionAdmission } from '../session-admission.js';
import {
    cleanupCoordinatorContexts,
    deferred,
    delayAdmissionStore,
    delaySecondAdmissionStore,
    messageContents,
    openCoordinatorContext,
    providerFromRequests,
} from './run-coordinator-test-support.js';

afterEach(async () => {
    await cleanupCoordinatorContexts();
});

describe('SessionRunCoordinator admission races', () => {
    it('does not miss a queued follow-up when admission durability is still in flight', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_queue_race');
        const holdAdmission = deferred<void>();
        const admissionBlocked = deferred<void>();
        const firstStarted = deferred<void>();
        const releaseFirst = deferred<void>();
        const requests: string[][] = [];
        const coordinator = context.createCoordinatorWithStore(
            delaySecondAdmissionStore(context.store, admissionBlocked, holdAdmission),
            providerFromRequests((request, index) => {
                requests.push([...messageContents(request.messages)]);
                if (index === 0) {
                    firstStarted.resolve();
                    return releaseFirst.promise;
                }
                return Promise.resolve();
            }),
        );
        await coordinator.steer({ inputId: 'input_first', messageId: 'message_first', prompt: 'first' });

        // When
        const wake = coordinator.wake();
        await firstStarted.promise;
        const queue = coordinator.queue({ inputId: 'input_second', messageId: 'message_second', prompt: 'second' });
        await admissionBlocked.promise;
        releaseFirst.resolve();
        const result = await wake;
        holdAdmission.resolve();
        await queue;
        const projection = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);

        // Then
        expect(result).toMatchObject({ status: 'completed', turns: 2 });
        expect(requests).toEqual([['first'], ['first', 'second']]);
        expect(projection.pendingInputs).toEqual([]);
        await context.store.close();
    });

    it('preserves queued branch context when admission durability is still in flight', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_queue_context_race');
        const holdAdmission = deferred<void>();
        const admissionBlocked = deferred<void>();
        const activeStarted = deferred<void>();
        const releaseActive = deferred<void>();
        const coordinator = context.createCoordinatorWithStore(
            delayAdmissionStore(context.store, 'input_branch', admissionBlocked, holdAdmission),
            providerFromRequests((_request, index) => {
                if (index === 2) {
                    activeStarted.resolve();
                    return releaseActive.promise;
                }
                return Promise.resolve();
            }),
        );
        await coordinator.steer({ inputId: 'input_root', messageId: 'message_root', prompt: 'root' });
        await coordinator.wake();
        await coordinator.queue({ inputId: 'input_leaf', messageId: 'message_leaf', prompt: 'leaf' });
        await coordinator.run();
        await coordinator.steer({ inputId: 'input_active', messageId: 'message_active', prompt: 'active' });

        // When
        const wake = coordinator.wake();
        await activeStarted.promise;
        const queue = coordinator.queue({
            inputId: 'input_branch',
            messageId: 'message_branch',
            parentMessageId: 'message_root',
            prompt: 'branch from root',
        });
        await admissionBlocked.promise;
        releaseActive.resolve();
        await wake;
        holdAdmission.resolve();
        await queue;
        const projection = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);
        const branch = projection.modelVisibleMessages.find((message) => message.inputId === 'input_branch');

        // Then
        expect(branch).toMatchObject({ parentMessageId: 'message_root' });
        await context.store.close();
    });
});
