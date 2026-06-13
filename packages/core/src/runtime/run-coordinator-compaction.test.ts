import { afterEach, describe, expect, it } from 'vitest';
import {
    compacted,
    promptPromoted,
    providerCompleted,
    sessionCompactionTestSessionId,
} from '../session-compaction-test-support.js';
import {
    cleanupCoordinatorContexts,
    messageContents,
    openCoordinatorContext,
    providerFromRequests,
} from './run-coordinator-test-support.js';

afterEach(async () => {
    await cleanupCoordinatorContexts();
});

describe('SessionRunCoordinator compaction replay', () => {
    it('uses compaction-aware default replay for provider turns', async () => {
        const context = await openCoordinatorContext(sessionCompactionTestSessionId);
        const requests: string[][] = [];

        await context.store.append(promptPromoted('input_old', 'message_old', 'OLD_PROMPT_SHOULD_BE_PRUNED'));
        await context.store.append(providerCompleted('old result'));
        await context.store.append(promptPromoted('input_recent', 'message_recent', 'RECENT_PROMPT_SHOULD_BE_KEPT'));
        await context.store.append(providerCompleted('recent result'));
        await context.store.append(compacted('COMPACTION_SUMMARY_SHOULD_BE_VISIBLE', 2, 3));

        const coordinator = context.createCoordinator(
            providerFromRequests((request) => {
                requests.push([...messageContents(request.messages)]);
                return Promise.resolve();
            }),
        );
        await coordinator.steer({
            inputId: 'input_new',
            messageId: 'message_new',
            prompt: 'NEW_PROMPT',
        });
        await coordinator.wake();

        expect(requests).toEqual([
            [
                'Session memory summary (untrusted, model-generated):\nCOMPACTION_SUMMARY_SHOULD_BE_VISIBLE',
                'RECENT_PROMPT_SHOULD_BE_KEPT',
                'recent result',
                'NEW_PROMPT',
            ],
        ]);
        await context.store.close();
    });
});
