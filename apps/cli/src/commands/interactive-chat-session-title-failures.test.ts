import type { ProviderAdapter } from '@mission-control/core';
import { describe, expect, it, vi } from 'vitest';
import {
    applyGeneratedSessionTitle,
    initializeInteractiveSessionTitle,
    runSessionTitleGeneration,
} from './interactive-chat-session-title.js';
import {
    activeSelection,
    authStoreWithRoles,
    completedChunk,
    createDeferred,
    failingProvider,
    mutableTitleState,
    registerTestTask,
    testSignal,
} from './interactive-chat-session-title-test-support.js';

describe('interactive session title generation failures', () => {
    it('preserves a non-empty manual title that exists before lazy initialization', async () => {
        // Given: a manual display title established before the first plain prompt creates a session.
        const persistTitle = vi.fn(async () => undefined);
        let providerCalled = false;
        const provider: ProviderAdapter = {
            async *streamTurn(request) {
                providerCalled = true;
                yield completedChunk(request, 'Generated title');
            },
        };
        const mutable = mutableTitleState({
            sessionId: 'session_preexisting_manual',
            displayName: 'Manual before session',
            persistOverride: persistTitle,
        });

        // When: lazy title initialization observes the pre-existing title.
        await initializeInteractiveSessionTitle({
            sessionId: 'session_preexisting_manual',
            prompt: 'Prompt title',
            state: mutable.state,
            model: { activeSelection, activeProvider: provider },
            signal: testSignal,
            registerBackgroundTask: registerTestTask,
        });

        // Then: no automatic persistence, display update, or provider generation occurs.
        expect(persistTitle).not.toHaveBeenCalled();
        expect(providerCalled).toBe(false);
        expect(mutable.displayName()).toBe('Manual before session');
    });

    it('skips an initial prompt write when a manual rename happens while it is queued', async () => {
        // Given: initial prompt persistence queued behind a deferred blocker.
        const releaseBlocker = createDeferred<void>();
        const persistTitle = vi.fn(async () => undefined);
        let providerCalled = false;
        const provider: ProviderAdapter = {
            async *streamTurn(request) {
                providerCalled = true;
                yield completedChunk(request, 'Generated title');
            },
        };
        const mutable = mutableTitleState({ sessionId: 'session_initial_queue', persistOverride: persistTitle });
        const blocker = mutable.state.enqueueWrite(async () => {
            await releaseBlocker.promise;
        });
        const initialization = initializeInteractiveSessionTitle({
            sessionId: 'session_initial_queue',
            prompt: 'Prompt title',
            state: mutable.state,
            model: { activeSelection, activeProvider: provider },
            signal: testSignal,
            registerBackgroundTask: registerTestTask,
        });

        // When: a manual title supersedes the prompt title before its callback executes.
        mutable.manualRename('Manual title');
        releaseBlocker.resolve();
        await initialization;
        await blocker;

        // Then: prompt persistence and background generation are both skipped.
        expect(persistTitle).not.toHaveBeenCalled();
        expect(providerCalled).toBe(false);
        expect(mutable.displayName()).toBe('Manual title');
    });

    it('does not display an undurable prompt title when its initial write fails', async () => {
        // Given: a first prompt, a failing metadata write, and an otherwise usable title provider.
        let providerCalled = false;
        const provider: ProviderAdapter = {
            async *streamTurn(request) {
                providerCalled = true;
                yield completedChunk(request, 'Generated title');
            },
        };
        const mutable = mutableTitleState({
            sessionId: 'session_initial_persist_failure',
            persistOverride: async () => {
                throw new Error('persistence unavailable');
            },
        });

        // When: automatic title initialization attempts its required prompt-title write.
        await initializeInteractiveSessionTitle({
            sessionId: 'session_initial_persist_failure',
            prompt: '  Prompt   title  ',
            state: mutable.state,
            model: { activeSelection, activeProvider: provider },
            signal: testSignal,
            registerBackgroundTask: registerTestTask,
        });

        // Then: display remains under durable authority and background generation is not started.
        expect(mutable.displayName()).toBeUndefined();
        expect(providerCalled).toBe(false);
    });

    it('leaves the prompt title unchanged when the title provider fails', async () => {
        // Given: a prompt title and a provider that completes with a non-retryable failure.
        const mutable = mutableTitleState({ sessionId: 'session_failure', displayName: 'Investigate failure' });

        // When: background title generation runs.
        await runSessionTitleGeneration({
            sessionId: 'session_failure',
            prompt: 'Investigate failure',
            promptTitle: 'Investigate failure',
            manualRenameRevision: 0,
            state: mutable.state,
            model: { activeSelection, activeProvider: failingProvider() },
            signal: testSignal,
        });

        // Then: no generated title is persisted or displayed.
        expect(mutable.persisted()).toEqual([]);
        expect(mutable.displayName()).toBe('Investigate failure');
    });

    it('does not use the active provider for a different role selection', async () => {
        // Given: a persisted title role whose provider cannot be resolved.
        const mutable = mutableTitleState({ sessionId: 'session_unresolved', displayName: 'Resolve provider' });
        let activeProviderCalled = false;
        const activeProvider: ProviderAdapter = {
            async *streamTurn(request) {
                activeProviderCalled = true;
                yield completedChunk(request, 'unexpected active-provider call');
            },
        };

        // When: title generation selects that role without a provider resolver.
        await runSessionTitleGeneration({
            sessionId: 'session_unresolved',
            prompt: 'Resolve provider',
            promptTitle: 'Resolve provider',
            manualRenameRevision: 0,
            state: mutable.state,
            model: {
                activeSelection,
                activeProvider,
                authStore: authStoreWithRoles({ title: { providerID: 'roles', modelID: 'title-model' } }),
            },
            signal: testSignal,
        });

        // Then: generation is a silent no-op instead of calling the mismatched active provider.
        expect(activeProviderCalled).toBe(false);
        expect(mutable.persisted()).toEqual([]);
        expect(mutable.displayName()).toBe('Resolve provider');
    });

    it('retains the prompt title when generated-title persistence fails', async () => {
        // Given: a completed title response and a persistence boundary that rejects it.
        const mutable = mutableTitleState({
            sessionId: 'session_persist_failure',
            displayName: 'Prompt title',
            persistOverride: async () => {
                throw new Error('persistence unavailable');
            },
        });

        // When: the generated title is conditionally applied.
        const applied = await applyGeneratedSessionTitle({
            sessionId: 'session_persist_failure',
            promptTitle: 'Prompt title',
            generatedTitle: 'Generated title',
            manualRenameRevision: 0,
            state: mutable.state,
        });

        // Then: the failure is reported as a no-op and the prompt title remains displayed.
        expect(applied).toBe(false);
        expect(mutable.displayName()).toBe('Prompt title');
    });
});
