import type { ProviderAdapter, ProviderTurnRequest } from '@mission-control/core';
import { describe, expect, it, vi } from 'vitest';
import {
    applyGeneratedSessionTitle,
    createSessionTitleWriteQueue,
    drainSessionTitleWriteQueue,
    initializeInteractiveSessionTitle,
    runSessionTitleGeneration,
} from './interactive-chat-session-title';
import {
    activeSelection,
    completedChunk,
    createDeferred,
    deferredProvider,
    mutableTitleState,
    testSignal,
    waitForAbort,
} from './interactive-chat-session-title-test-support';
import { createAuthStoreWithSummaries, createFieldsCredential } from './run-agent-chat-test-support';

describe('interactive session title concurrency', () => {
    it('drains generated and manual writes in request order before continuing', async () => {
        // Given: an in-flight generated write and a manual write queued behind it.
        const releaseGenerated = createDeferred<void>();
        const writeOrder: string[] = [];
        const enqueueWrite = createSessionTitleWriteQueue();
        const generatedWrite = enqueueWrite(async () => {
            await releaseGenerated.promise;
            writeOrder.push('generated');
        });
        const manualWrite = enqueueWrite(async () => {
            writeOrder.push('manual');
        });

        // When: lifecycle code requests a queue drain before switching stores.
        const drain = drainSessionTitleWriteQueue(enqueueWrite).then(() => {
            writeOrder.push('drained');
        });
        releaseGenerated.resolve();
        await drain;
        await Promise.all([generatedWrite, manualWrite]);

        // Then: all prior writes finish in order before the drain resolves.
        expect(writeOrder).toEqual(['generated', 'manual', 'drained']);
    });

    it('skips generated persistence when the session changes while its write is queued', async () => {
        // Given: a generated write queued behind a deferred persistence blocker.
        const releaseBlocker = createDeferred<void>();
        const persistTitle = vi.fn(async () => undefined);
        const mutable = mutableTitleState({
            sessionId: 'session_before_switch',
            displayName: 'Prompt title',
            persistOverride: persistTitle,
        });
        const blocker = mutable.state.enqueueWrite(async () => {
            await releaseBlocker.promise;
        });
        const generatedWrite = applyGeneratedSessionTitle({
            sessionId: 'session_before_switch',
            promptTitle: 'Prompt title',
            generatedTitle: 'Generated title',
            manualRenameRevision: 0,
            state: mutable.state,
        });

        // When: the active session changes before the generated callback executes.
        mutable.switchSession('session_after_switch');
        releaseBlocker.resolve();
        const applied = await generatedWrite;
        await blocker;

        // Then: callback-time eligibility reports a skip and never calls persistence.
        expect(applied).toBe(false);
        expect(persistTitle).not.toHaveBeenCalled();
    });

    it('persists a manual rename last when a generated-title write is already in flight', async () => {
        // Given: a generated-title persistence call paused before its durable event lands.
        const firstWriteStarted = createDeferred<void>();
        const releaseFirstWrite = createDeferred<void>();
        const durableTitles: string[] = [];
        let isFirstWrite = true;
        const mutable = mutableTitleState({
            sessionId: 'session_write_order',
            displayName: 'Prompt title',
            persistOverride: async (title) => {
                if (isFirstWrite) {
                    isFirstWrite = false;
                    firstWriteStarted.resolve();
                    await releaseFirstWrite.promise;
                }
                durableTitles.push(title);
            },
        });
        const generatedWrite = applyGeneratedSessionTitle({
            sessionId: 'session_write_order',
            promptTitle: 'Prompt title',
            generatedTitle: 'Generated title',
            manualRenameRevision: 0,
            state: mutable.state,
        });
        await firstWriteStarted.promise;

        // When: a manual rename is requested before the generated write completes.
        const manualWrite = mutable.manualRenameAndPersist('Manual title');
        releaseFirstWrite.resolve();
        await Promise.all([generatedWrite, manualWrite]);

        // Then: request-order serialization makes the manual event and visible title final.
        expect(durableTitles).toEqual(['Generated title', 'Manual title']);
        expect(durableTitles.at(-1)).toBe('Manual title');
        expect(mutable.displayName()).toBe('Manual title');
    });

    it('does not overwrite a manual rename made while generation is in flight', async () => {
        // Given: title generation waiting on a deferred provider response.
        const completion = createDeferred<string>();
        const requests: ProviderTurnRequest[] = [];
        const mutable = mutableTitleState({ sessionId: 'session_manual_guard', displayName: 'Prompt title' });
        const generation = runSessionTitleGeneration({
            sessionId: 'session_manual_guard',
            prompt: 'Prompt title',
            promptTitle: 'Prompt title',
            manualRenameRevision: 0,
            state: mutable.state,
            model: { activeSelection, activeProvider: deferredProvider(completion.promise, requests) },
            signal: testSignal,
        });
        await vi.waitFor(() => {
            expect(requests).toHaveLength(1);
        });

        // When: the user manually renames the same session before generation completes.
        await mutable.manualRenameAndPersist('My manual title');
        completion.resolve('Generated intent title');
        await generation;

        // Then: the revision guard skips generated persistence and preserves the manual event and title.
        expect(mutable.persisted()).toEqual(['My manual title']);
        expect(mutable.displayName()).toBe('My manual title');
    });

    it('exact-redacts a stored credential returned in the generated title', async () => {
        // Given: a title provider that returns an arbitrary stored secret with no heuristic credential shape.
        const storedSecret = 'violet-harbor-candle';
        const provider: ProviderAdapter = {
            async *streamTurn(request) {
                yield completedChunk(request, `Review ${storedSecret} handling`);
            },
        };
        const authStore = createAuthStoreWithSummaries([], {
            active: createFieldsCredential('active', storedSecret),
        });
        const mutable = mutableTitleState({ sessionId: 'session_generated_secret', displayName: 'Prompt title' });

        // When: generated title output crosses the auth-backed title boundary.
        await runSessionTitleGeneration({
            sessionId: 'session_generated_secret',
            prompt: 'Prompt title',
            promptTitle: 'Prompt title',
            manualRenameRevision: 0,
            state: mutable.state,
            model: {
                activeSelection,
                activeProvider: provider,
                authStore,
            },
            signal: testSignal,
        });

        // Then: both durable and displayed titles contain only the redaction marker in place of the secret.
        const expectedTitle = 'Review [REDACTED_CREDENTIAL] handling';
        expect(mutable.persisted()).toEqual([expectedTitle]);
        expect(mutable.displayName()).toBe(expectedTitle);
        expect(mutable.displayName()).not.toContain(storedSecret);
    });

    it('returns after prompt persistence without waiting for the deferred title provider', async () => {
        // Given: a first prompt and a title provider whose completion is deferred.
        const completion = createDeferred<string>();
        const requests: ProviderTurnRequest[] = [];
        const generatedDisplay = createDeferred<void>();
        let backgroundTask: Promise<void> | undefined;
        const mutable = mutableTitleState({
            sessionId: 'session_nonblocking',
            onDisplay: (title) => {
                if (title === 'Generated intent title') generatedDisplay.resolve();
            },
        });

        // When: automatic title initialization starts the background provider request.
        await initializeInteractiveSessionTitle({
            sessionId: 'session_nonblocking',
            prompt: '  First   prompt  ',
            state: mutable.state,
            model: { activeSelection, activeProvider: deferredProvider(completion.promise, requests) },
            signal: testSignal,
            registerBackgroundTask: (task) => {
                backgroundTask = task;
            },
        });

        // Then: initialization has persisted the prompt title while provider completion is still pending.
        await vi.waitFor(() => {
            expect(requests).toHaveLength(1);
        });
        expect(mutable.persisted()).toEqual(['First prompt']);
        expect(mutable.displayName()).toBe('First prompt');

        completion.resolve('Generated intent title');
        await generatedDisplay.promise;
        if (backgroundTask === undefined) {
            throw new Error('expected title generation to register its background task');
        }
        await backgroundTask;
        expect(mutable.persisted()).toEqual(['First prompt', 'Generated intent title']);
        expect(mutable.displayName()).toBe('Generated intent title');
    });

    it('propagates cancellation to the provider and settles the registered task', async () => {
        // Given: tracked title generation blocked inside a provider stream.
        const controller = new AbortController();
        const providerStarted = createDeferred<AbortSignal>();
        let backgroundTask: Promise<void> | undefined;
        const provider: ProviderAdapter = {
            async *streamTurn(request, context) {
                providerStarted.resolve(context.signal);
                await waitForAbort(context.signal);
                yield {
                    kind: 'response_failed',
                    requestId: request.requestId,
                    sequence: 1,
                    error: { code: 'provider_aborted', message: 'provider turn aborted', retryable: false },
                };
            },
        };
        const mutable = mutableTitleState({ sessionId: 'session_abort' });
        await initializeInteractiveSessionTitle({
            sessionId: 'session_abort',
            prompt: 'Prompt title',
            state: mutable.state,
            model: { activeSelection, activeProvider: provider },
            signal: controller.signal,
            registerBackgroundTask: (task) => {
                backgroundTask = task;
            },
        });
        const providerSignal = await providerStarted.promise;

        // Then: the provider receives a deadline-combined signal rather than the lifecycle signal directly.
        expect(providerSignal).not.toBe(controller.signal);
        expect(providerSignal.aborted).toBe(false);

        // When: the owning chat lifecycle aborts title generation.
        controller.abort();
        if (backgroundTask === undefined) {
            throw new Error('expected title generation to register its background task');
        }
        await backgroundTask;

        // Then: the provider observes cancellation and no detached task remains pending.
        expect(providerSignal.aborted).toBe(true);
    });
});
