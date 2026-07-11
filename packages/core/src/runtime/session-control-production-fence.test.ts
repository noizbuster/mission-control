import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderTurnRunner } from '../providers/provider-turn-runner.js';
import type { ProviderAdapter, ProviderStreamChunk } from '../providers/provider-turn-types.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { expireSessionControlLease } from './session-control-lease.js';
import {
    createSessionControlCallbackFence,
    createSessionControlOperation,
    readSessionControlOperation,
} from './session-control-operation.js';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createMutationProbe,
    createOperationTestRuntime,
    readMutationProbe,
} from './session-control-operation-test-support.js';

afterEach(cleanupOperationTestRuntimes);

describe('production session-control callback fencing', () => {
    it('quarantines a stale provider terminal envelope before its durable writer runs', async () => {
        const runtime = await createOperationTestRuntime();
        const oldLease = await acquireOperationTestLease(runtime, 'owner-provider-old', 1_000);
        await createMutationProbe(runtime);
        await createSessionControlOperation({
            runtime,
            lease: oldLease,
            operationId: 'operation-provider',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['provider:request-provider-stale'],
            nowWallMs: 1_100,
        });
        await expireSessionControlLease({ runtime, lease: oldLease, nowWallMs: 2_000 });
        await acquireOperationTestLease(runtime, 'owner-provider-new', 2_000);
        const provider: ProviderAdapter = { streamTurn: () => completedProviderStream() };
        const runner = new ProviderTurnRunner({ provider, retryLimit: 0 });

        const result = await runner.runTurn({
            requestId: 'request-provider-stale',
            sessionId: oldLease.sessionId,
            turnId: 'turn-provider-stale',
            providerID: 'test',
            modelID: 'test',
            messages: [{ role: 'user', content: 'work' }],
            startSequence: 0,
            controlEpoch: {
                dbIdentity: oldLease.dbIdentity,
                sessionId: oldLease.sessionId,
                ownerId: oldLease.ownerId,
                ownerEpoch: oldLease.epoch,
                callbackFence: createSessionControlCallbackFence({
                    runtime,
                    lease: oldLease,
                    operationId: 'operation-provider',
                    nowWallMs: () => 2_100,
                }),
            },
            writeEnvelope: async (envelope, client) => {
                if (envelope.event.type === 'model.call.completed' && client !== undefined) {
                    await client.execute("INSERT INTO mutation_probe (value) VALUES ('provider-terminal')");
                }
            },
        });

        expect(result).toMatchObject({ status: 'failed', error: { code: 'provider_aborted' } });
        expect(await readMutationProbe(runtime)).toEqual([]);
        runtime.close();
    });

    it('fails closed without a controlled provider writer and publishes no observer event', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-provider-no-writer', 1_000);
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-provider-no-writer',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['provider:request-provider-no-writer'],
            nowWallMs: 1_100,
        });
        const observed: unknown[] = [];
        const runner = new ProviderTurnRunner({
            provider: { streamTurn: () => completedProviderStream('request-provider-no-writer') },
            retryLimit: 0,
        });

        const result = await runner.runTurn({
            requestId: 'request-provider-no-writer',
            sessionId: lease.sessionId,
            turnId: 'turn-provider-no-writer',
            providerID: 'test',
            modelID: 'test',
            messages: [{ role: 'user', content: 'work' }],
            startSequence: 0,
            controlEpoch: {
                dbIdentity: lease.dbIdentity,
                sessionId: lease.sessionId,
                ownerId: lease.ownerId,
                ownerEpoch: lease.epoch,
                callbackFence: createSessionControlCallbackFence({
                    runtime,
                    lease,
                    operationId: 'operation-provider-no-writer',
                    nowWallMs: () => 1_200,
                }),
            },
            onEnvelope: (envelope) => observed.push(envelope),
        });

        expect(result).toMatchObject({ status: 'failed', error: { code: 'provider_aborted' } });
        expect(observed).toEqual([]);
        expect(
            await readSessionControlOperation(
                runtime,
                lease.dbIdentity,
                lease.sessionId,
                'operation-provider-no-writer',
            ),
        ).toMatchObject({ settledHandleIds: [] });
        runtime.close();
    });

    it('does not publish a terminal observer event when the provider writer rejects', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-provider-reject', 1_000);
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-provider-reject',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['provider:request-provider-reject'],
            nowWallMs: 1_100,
        });
        const observedTypes: string[] = [];
        const runner = new ProviderTurnRunner({
            provider: { streamTurn: () => completedProviderStream('request-provider-reject') },
            retryLimit: 0,
        });

        await expect(
            runner.runTurn({
                requestId: 'request-provider-reject',
                sessionId: lease.sessionId,
                turnId: 'turn-provider-reject',
                providerID: 'test',
                modelID: 'test',
                messages: [{ role: 'user', content: 'work' }],
                startSequence: 0,
                controlEpoch: {
                    dbIdentity: lease.dbIdentity,
                    sessionId: lease.sessionId,
                    ownerId: lease.ownerId,
                    ownerEpoch: lease.epoch,
                    callbackFence: createSessionControlCallbackFence({
                        runtime,
                        lease,
                        operationId: 'operation-provider-reject',
                        nowWallMs: () => 1_200,
                    }),
                },
                onEnvelope: (envelope) => observedTypes.push(envelope.event.type),
                writeEnvelope: async (envelope) => {
                    if (envelope.event.type === 'model.call.completed') throw new Error('provider writer rejected');
                },
            }),
        ).rejects.toThrow('provider writer rejected');

        expect(observedTypes).not.toContain('model.call.completed');
        expect(observedTypes).not.toContain('model.call.failed');
        expect(
            await readSessionControlOperation(runtime, lease.dbIdentity, lease.sessionId, 'operation-provider-reject'),
        ).toMatchObject({ settledHandleIds: [] });
        runtime.close();
    });

    it('publishes the provider terminal observer only after fence commit', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-provider-order', 1_000);
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-provider-order',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['provider:request-provider-order'],
            nowWallMs: 1_100,
        });
        const fence = createSessionControlCallbackFence({
            runtime,
            lease,
            operationId: 'operation-provider-order',
            nowWallMs: () => 1_200,
        });
        let committed = false;
        const observerCommitStates: boolean[] = [];
        const runner = new ProviderTurnRunner({
            provider: { streamTurn: () => completedProviderStream('request-provider-order') },
            retryLimit: 0,
        });

        const result = await runner.runTurn({
            requestId: 'request-provider-order',
            sessionId: 'session-provider-order',
            turnId: 'turn-provider-order',
            providerID: 'test',
            modelID: 'test',
            messages: [{ role: 'user', content: 'work' }],
            startSequence: 0,
            controlEpoch: {
                dbIdentity: lease.dbIdentity,
                sessionId: lease.sessionId,
                ownerId: lease.ownerId,
                ownerEpoch: lease.epoch,
                callbackFence: {
                    operationId: fence.operationId,
                    settle: async (attempt) => {
                        const settlement = await fence.settle(attempt);
                        committed = true;
                        return settlement;
                    },
                },
            },
            writeEnvelope: async () => undefined,
            onEnvelope: (envelope) => {
                if (envelope.event.type === 'model.call.completed') observerCommitStates.push(committed);
            },
        });

        expect(result.status).toBe('completed');
        expect(observerCommitStates).toEqual([true]);
        runtime.close();
    });

    it.each([
        ['command.run', 'command'],
        ['shell.session', 'shell'],
        ['task', 'subagent'],
        ['repo.read', 'tool'],
    ] as const)('routes %s terminal results through the callback fence as %s', async (toolName, handleKind) => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, `owner-${handleKind}`, 1_000);
        await createMutationProbe(runtime);
        const toolCallId = `call-${handleKind}`;
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: `operation-${handleKind}`,
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: [`${handleKind}:${toolCallId}`],
            nowWallMs: 1_100,
        });
        const registry = new ToolRegistry();
        const advertisement = registry.register({
            name: toolName,
            description: 'fenced terminal result',
            capabilityClasses: ['read'],
            parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
            inputSchema: z.object({}).strict(),
            outputSchema: z.object({ ok: z.literal(true) }).strict(),
            outputLimit: { maxModelOutputChars: 100 },
            execute: () => ({ ok: true as const }),
        });

        const settlement = await registry.invoke({
            toolCallId,
            toolName,
            advertisedVersion: advertisement.version,
            argumentsJson: '{}',
            controlEpoch: {
                dbIdentity: lease.dbIdentity,
                sessionId: lease.sessionId,
                ownerId: lease.ownerId,
                ownerEpoch: lease.epoch,
                callbackFence: createSessionControlCallbackFence({
                    runtime,
                    lease,
                    operationId: `operation-${handleKind}`,
                    nowWallMs: () => 1_200,
                }),
            },
            writeSettlement: (_terminal, client) =>
                client
                    .execute({ sql: 'INSERT INTO mutation_probe (value) VALUES (?)', args: [handleKind] })
                    .then(() => undefined),
        });

        expect(settlement.result.status).toBe('completed');
        expect(await readMutationProbe(runtime)).toEqual([{ value: handleKind }]);
        runtime.close();
    });
});

async function* completedProviderStream(requestId = 'request-provider-stale'): AsyncIterable<ProviderStreamChunk> {
    yield {
        kind: 'response_completed',
        requestId,
        sequence: 0,
        message: { messageId: 'message-provider-stale', role: 'assistant', content: 'late' },
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
}
