import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from './agent-runtime.js';
import { createDeterministicProvider } from './providers/deterministic-provider.js';
import type { ProviderAdapter, ProviderTurnRequest } from './providers/provider-turn-types.js';
import { ProjectTrustStore } from './trust/project-trust-store.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

    it('loads trusted project context into provider messages', async () => {
        const dataDir = await tempRoot('mctrl-runtime-context-data-');
        const workspaceRoot = await tempRoot('mctrl-runtime-context-workspace-');
        await writeFile(join(workspaceRoot, 'AGENTS.md'), 'TRUSTED_RUNTIME_CONTEXT', 'utf8');
        const trustStore = new ProjectTrustStore({ dataDir, now: fixedNow });
        const requests: ProviderTurnRequest[] = [];

        const unknownRuntime = new AgentRuntime({
            useNative: false,
            permissionDecisionResolver: allowAllPermissions,
            provider: captureProviderRequests(requests),
            projectContext: { workspaceRoot, trustStore },
        });
        await unknownRuntime.start();
        await unknownRuntime.runPromptTask('before trust');
        await trustStore.setDecision(workspaceRoot, 'trusted');
        const trustedRuntime = new AgentRuntime({
            useNative: false,
            permissionDecisionResolver: allowAllPermissions,
            provider: captureProviderRequests(requests),
            projectContext: { workspaceRoot, trustStore },
        });
        await trustedRuntime.start();
        await trustedRuntime.runPromptTask('after trust');

        expect(requests).toHaveLength(2);
        const [unknownRequest, trustedRequest] = requests;
        if (unknownRequest === undefined || trustedRequest === undefined) {
            throw new Error('expected provider requests');
        }
        expect(JSON.stringify(unknownRequest.messages)).not.toContain('TRUSTED_RUNTIME_CONTEXT');
        expect(trustedRequest.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'system',
                    content: expect.stringContaining('TRUSTED_RUNTIME_CONTEXT'),
                }),
            ]),
        );
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

function captureProviderRequests(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request: ProviderTurnRequest) {
            requests.push(request);
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: { messageId: `message_${request.turnId}`, role: 'assistant', content: 'captured' },
                finishReason: 'stop',
            };
        },
    };
}

async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(root);
    return root;
}

function fixedNow(): string {
    return '2026-06-13T00:00:00.000Z';
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
