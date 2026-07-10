import type { ProviderAdapter, ProviderAuthStore, ProviderTurnRequest } from '@mission-control/core';
import type { ModelProviderSelection, ModelRole, ProviderStreamChunk } from '@mission-control/protocol';
import { createSessionTitleWriteQueue } from './interactive-chat-session-title.js';
import { createEmptyAuthStore } from './run-agent-chat-test-support.js';

export const activeSelection: ModelProviderSelection = { providerID: 'active', modelID: 'large' };
export const testSignal = new AbortController().signal;

export type MutableTitleStateOptions = {
    readonly sessionId: string;
    readonly displayName?: string;
    readonly persistOverride?: (title: string) => Promise<void>;
    readonly onDisplay?: (title: string) => void;
};

export function mutableTitleState(options: MutableTitleStateOptions) {
    let currentSessionId = options.sessionId;
    let displayName = options.displayName;
    let manualRenameRevision = 0;
    const persisted: string[] = [];
    const enqueueWrite = createSessionTitleWriteQueue();
    const persistTitle = async (title: string): Promise<void> => {
        if (options.persistOverride !== undefined) {
            await options.persistOverride(title);
            return;
        }
        persisted.push(title);
    };
    return {
        state: {
            snapshot: () => ({ sessionId: currentSessionId, displayName, manualRenameRevision }),
            displayTitle: (title: string) => {
                displayName = title;
                options.onDisplay?.(title);
            },
            persistTitle,
            enqueueWrite,
        },
        displayName: () => displayName,
        persisted: () => persisted,
        manualRename: (title: string) => {
            manualRenameRevision += 1;
            displayName = title;
        },
        manualRenameAndPersist: (title: string) => {
            manualRenameRevision += 1;
            displayName = title;
            return enqueueWrite(() => persistTitle(title));
        },
        switchSession: (sessionId: string) => {
            currentSessionId = sessionId;
        },
    };
}

export function authStoreWithRoles(roles: Partial<Record<ModelRole, ModelProviderSelection>>): ProviderAuthStore {
    return {
        ...createEmptyAuthStore(),
        getModelRoles: async () => roles,
    };
}

export function failingProvider(): ProviderAdapter {
    return {
        async *streamTurn(request) {
            yield {
                kind: 'response_failed',
                requestId: request.requestId,
                sequence: 1,
                error: { code: 'unknown', message: 'title provider failed', retryable: false },
            };
        },
    };
}

export function deferredProvider(completion: Promise<string>, requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            yield completedChunk(request, await completion);
        },
    };
}

export function completedChunk(request: ProviderTurnRequest, content: string): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 1,
        message: { messageId: `message_${request.turnId}`, role: 'assistant', content },
        finishReason: 'stop',
    };
}

export function createDeferred<T>() {
    let resolvePromise = (_value: T): void => undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (value: T) => {
            resolvePromise(value);
        },
    };
}

export function registerTestTask(task: Promise<void>): void {
    void task.then(
        () => undefined,
        () => undefined,
    );
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
}
