import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from './agent-runtime.js';
import { createDeterministicProvider } from './providers/deterministic-provider.js';
import type { ProviderAdapter, ProviderTurnRequest } from './providers/provider-turn-types.js';

describe('AgentRuntime provider turns', () => {
    it('can route prompt tasks through a deterministic provider runner', async () => {
        const runtime = new AgentRuntime({
            useNative: false,
            permissionDecisionResolver: allowAllPermissions,
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'hel' },
                { kind: 'text_delta', delta: 'lo' },
                { kind: 'response_completed', content: 'hello' },
            ]),
        });
        const liveChunks: string[] = [];
        const unsubscribe = runtime.onEvent((event) => {
            const chunk = event.providerStreamChunk;
            if (chunk?.kind === 'text_delta') {
                liveChunks.push(chunk.delta);
            }
        });

        await runtime.start();
        const response = await runtime.runPromptTask('say hello');
        unsubscribe();

        expect(response).toBe('hello');
        expect(liveChunks).toEqual(['hel', 'lo']);
        expect(runtime.getEvents().some((event) => event.providerStreamChunk?.kind === 'text_delta')).toBe(false);
        expect(runtime.getSnapshot().lastMessage).toBe('hello');
    });

    it('blocks provider effects until a pending approval is approved', async () => {
        const releaseProvider = deferred<void>();
        let providerCalls = 0;
        const provider = {
            async *streamTurn(request: ProviderTurnRequest) {
                providerCalls += 1;
                await releaseProvider.promise;
                yield {
                    kind: 'response_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    message: { messageId: 'message_approved', role: 'assistant', content: 'approved response' },
                    finishReason: 'stop',
                };
            },
        } satisfies ProviderAdapter;
        const runtime = new AgentRuntime({
            useNative: false,
            provider,
            permissionDecisionResolver: requiresApproval,
        });

        await runtime.start();
        const approvalRequested = waitForEvent(runtime, 'approval.requested');
        const response = runtime.runPromptTask('needs approval');
        await approvalRequested;

        expect(providerCalls).toBe(0);
        expect(runtime.getEvents()).toContainEqual(
            expect.objectContaining({
                type: 'approval.requested',
                approvalRecord: expect.objectContaining({
                    approvalId: 'approval_permission_task_prompt_1',
                    state: 'pending',
                }),
            }),
        );
        runtime.updateApproval({
            approvalId: 'approval_permission_task_prompt_1',
            state: 'approved',
            reason: 'approved by test',
        });
        releaseProvider.resolve();

        await expect(response).resolves.toBe('approved response');
        expect(providerCalls).toBe(1);
        expect(runtime.getEvents().map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.updated', 'approval.resumed', 'task.completed']),
        );
    });

    it.each(blockingApprovalCases)('blocks provider effects when approval is $state', async ({ state, code }) => {
        let providerCalls = 0;
        const provider = {
            async *streamTurn(request: ProviderTurnRequest) {
                providerCalls += 1;
                yield {
                    kind: 'response_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    message: { messageId: 'message_blocked', role: 'assistant', content: 'should not stream' },
                    finishReason: 'stop',
                };
            },
        } satisfies ProviderAdapter;
        const runtime = new AgentRuntime({
            useNative: false,
            provider,
            permissionDecisionResolver: requiresApproval,
        });

        await runtime.start();
        const approvalRequested = waitForEvent(runtime, 'approval.requested');
        const response = runtime.runPromptTask(`approval ${state}`);
        await approvalRequested;
        runtime.updateApproval({
            approvalId: 'approval_permission_task_prompt_1',
            state,
            reason: `test ${state}`,
        });

        await expect(response).rejects.toMatchObject({ code });
        expect(providerCalls).toBe(0);
        expect(runtime.getEvents().map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.updated', 'approval.blocked']),
        );
        expect(runtime.getEvents().some((event) => event.type === 'task.started')).toBe(false);
    });
});

const blockingApprovalCases = [
    { state: 'denied', code: 'approval_denied' },
    { state: 'expired', code: 'approval_expired' },
    { state: 'cancelled', code: 'approval_cancelled' },
] as const;

function allowAllPermissions(request: PermissionRequest): PermissionDecision {
    return {
        requestId: request.id,
        status: 'allow',
        reason: 'test allow',
    };
}

function requiresApproval(request: PermissionRequest): PermissionDecision {
    return {
        requestId: request.id,
        status: 'requires_approval',
        reason: 'test requires approval',
    };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

function waitForEvent(runtime: AgentRuntime, type: AgentEvent['type']): Promise<AgentEvent> {
    let unsubscribe = (): void => undefined;
    return new Promise<AgentEvent>((resolve) => {
        unsubscribe = runtime.onEvent((event) => {
            if (event.type === type) {
                unsubscribe();
                resolve(event);
            }
        });
    });
}
