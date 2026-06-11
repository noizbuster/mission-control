import { afterEach, describe, expect, it } from 'vitest';
import { projectSessionAdmission } from '../session-admission.js';
import {
    cleanupCoordinatorContexts,
    messageContents,
    openCoordinatorContext,
    providerFromRequests,
} from './run-coordinator-test-support.js';

afterEach(async () => {
    await cleanupCoordinatorContexts();
});

describe('SessionRunCoordinator malformed prompt handling', () => {
    it('does not promote a rejected empty prompt from the durable command fallback', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_empty_prompt');
        const requests: string[][] = [];
        const coordinator = context.createCoordinator(
            providerFromRequests((request) => {
                requests.push([...messageContents(request.messages)]);
                return Promise.resolve();
            }),
        );

        // When
        await expect(
            coordinator.queue({ inputId: 'input_bad', messageId: 'message_bad', prompt: '' }),
        ).rejects.toMatchObject({ code: 'empty_prompt' });
        await coordinator.run();
        const projection = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);
        const commandInputs = (await context.events()).flatMap((event) =>
            event.type === 'run.command.received' && event.run?.inputId !== undefined ? [event.run.inputId] : [],
        );

        // Then
        expect(requests).toEqual([[]]);
        expect(projection.modelVisibleMessages).toEqual([]);
        expect(commandInputs).not.toContain('input_bad');
        await context.store.close();
    });

    it('does not record a promotable command for a reused promoted input id', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_duplicate_prompt');
        const requests: string[][] = [];
        const coordinator = context.createCoordinator(
            providerFromRequests((request) => {
                requests.push([...messageContents(request.messages)]);
                return Promise.resolve();
            }),
        );
        await coordinator.queue({
            inputId: 'input_duplicate',
            messageId: 'message_duplicate',
            prompt: 'first prompt',
        });
        await coordinator.run();

        // When
        await expect(
            coordinator.queue({
                inputId: 'input_duplicate',
                messageId: 'message_duplicate',
                prompt: 'first prompt',
            }),
        ).rejects.toMatchObject({ code: 'input_conflict' });
        await coordinator.run();
        const projection = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);
        const commandInputs = (await context.events()).flatMap((event) =>
            event.type === 'run.command.received' && event.run?.inputId !== undefined ? [event.run.inputId] : [],
        );

        // Then
        expect(requests).toEqual([['first prompt'], ['first prompt']]);
        expect(projection.modelVisibleMessages.map((message) => message.content)).toEqual(['first prompt']);
        expect(commandInputs.filter((inputId) => inputId === 'input_duplicate')).toHaveLength(1);
        await context.store.close();
    });

    it('rejects duplicate pending input when transcript context changes', async () => {
        // Given
        const context = await openCoordinatorContext('session_run_duplicate_context');
        const coordinator = context.createCoordinator(providerFromRequests(() => Promise.resolve()));
        await coordinator.queue({
            inputId: 'input_same',
            messageId: 'message_same',
            parentMessageId: 'parent_a',
            prompt: 'same prompt',
            resume: false,
        });

        // When
        await expect(
            coordinator.queue({
                inputId: 'input_same',
                messageId: 'message_same',
                parentMessageId: 'parent_b',
                prompt: 'same prompt',
                resume: false,
            }),
        ).rejects.toMatchObject({ code: 'input_conflict' });
        await coordinator.run();
        const projection = projectSessionAdmission(await context.store.getEvents(context.sessionId), context.sessionId);
        const commandInputs = (await context.events()).flatMap((event) =>
            event.type === 'run.command.received' && event.run?.inputId !== undefined ? [event.run.inputId] : [],
        );

        // Then
        expect(projection.modelVisibleMessages).toMatchObject([{ parentMessageId: 'parent_a' }]);
        expect(commandInputs.filter((inputId) => inputId === 'input_same')).toHaveLength(1);
        await context.store.close();
    });
});
