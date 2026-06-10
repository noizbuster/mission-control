import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderTurnRequest } from '../providers/provider-turn-types.js';
import { SessionRunCoordinator } from './run-coordinator.js';
import {
    cleanupCoordinatorContexts,
    openCoordinatorContext,
    providerFromRequests,
} from './run-coordinator-test-support.js';

afterEach(async () => {
    await cleanupCoordinatorContexts();
});

describe('SessionRunCoordinator provider selection', () => {
    it('passes variantID to provider turn requests', async () => {
        const context = await openCoordinatorContext('session_run_variant');
        const requests: ProviderTurnRequest[] = [];
        const coordinator = new SessionRunCoordinator({
            sessionId: context.sessionId,
            store: context.store,
            provider: providerFromRequests((request) => {
                requests.push(request);
                return Promise.resolve();
            }),
            modelProviderSelection: {
                providerID: 'openai',
                modelID: 'gpt-5',
                variantID: 'reasoning-high',
            },
            timeoutMs: 50,
            createId: (prefix, index) => `${prefix}_${index}`,
        });

        await coordinator.queue({
            inputId: 'input_variant',
            messageId: 'message_variant',
            prompt: 'use variant',
        });
        await coordinator.resume();

        expect(requests[0]).toMatchObject({
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
        });
        await context.store.close();
    });
});
