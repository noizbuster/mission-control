import type { AgentEvent } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { expireSessionControlLease } from '../../../runtime/session-control-lease';
import {
    createSessionControlCallbackFence,
    createSessionControlOperation,
    readSessionControlOperation,
} from '../../../runtime/session-control-operation';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createOperationTestRuntime,
} from '../../../runtime/session-control-operation-test-support';
import { ToolRegistry } from '../../../tools/tool-registry';
import { bridgeAdvertisementToAiSdk, createAbgToolSettlementLedger } from './abg-tool-bridge';

afterEach(cleanupOperationTestRuntimes);

const forwardedEvent: AgentEvent = {
    type: 'native.warning',
    timestamp: '2026-07-11T00:00:00.000Z',
    message: 'forwarded',
};

describe('ABG production tool callback fencing', () => {
    it('does not record ledger or tool events for a stale callback', async () => {
        const runtime = await createOperationTestRuntime();
        const oldLease = await acquireOperationTestLease(runtime, 'owner-abg-old', 1_000);
        const registry = new ToolRegistry();
        const advertisement = registry.register(registration());
        const ledger = createAbgToolSettlementLedger();
        const forwarded: AgentEvent[] = [];
        await createSessionControlOperation({
            runtime,
            lease: oldLease,
            operationId: 'operation-abg-stale',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['tool:abg-stale'],
            nowWallMs: 1_100,
        });
        await expireSessionControlLease({ runtime, lease: oldLease, nowWallMs: 2_000 });
        await acquireOperationTestLease(runtime, 'owner-abg-new', 2_000);
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, {
            controlEpoch: epoch(runtime, oldLease, 'operation-abg-stale'),
            settlementLedger: ledger,
            onToolEvent: (event) => forwarded.push(event),
        });
        if (bridged.execute === undefined) throw new Error('bridged tool missing execute');

        await bridged.execute({}, executionOptions('abg-stale'));

        expect(ledger.lookup('abg-stale')).toBeUndefined();
        expect(forwarded).toEqual([]);
        runtime.close();
    });

    it('records accepted ledger and tool events and settles the operation handle', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-abg-live', 1_000);
        const registry = new ToolRegistry();
        const advertisement = registry.register(registration());
        const ledger = createAbgToolSettlementLedger();
        const forwarded: AgentEvent[] = [];
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-abg-live',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['tool:abg-live'],
            nowWallMs: 1_100,
        });
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, {
            controlEpoch: epoch(runtime, lease, 'operation-abg-live'),
            settlementLedger: ledger,
            onToolEvent: (event) => forwarded.push(event),
        });
        if (bridged.execute === undefined) throw new Error('bridged tool missing execute');

        await bridged.execute({}, executionOptions('abg-live'));

        expect(ledger.lookup('abg-live')?.status).toBe('completed');
        expect(forwarded).toEqual([forwardedEvent]);
        expect(
            await readSessionControlOperation(runtime, lease.dbIdentity, lease.sessionId, 'operation-abg-live'),
        ).toMatchObject({ settledHandleIds: ['tool:abg-live'] });
        runtime.close();
    });

    it('publishes accepted ledger and tool observers only after the fence transaction commits', async () => {
        // Given
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-abg-order', 1_000);
        const registry = new ToolRegistry();
        const advertisement = registry.register(registration());
        const ledger = createAbgToolSettlementLedger();
        const realFence = createSessionControlCallbackFence({
            runtime,
            lease,
            operationId: 'operation-abg-order',
            nowWallMs: () => 2_100,
        });
        let committed = false;
        const observerCommitStates: boolean[] = [];
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-abg-order',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['tool:abg-order'],
            nowWallMs: 1_100,
        });
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, {
            controlEpoch: {
                dbIdentity: lease.dbIdentity,
                sessionId: lease.sessionId,
                ownerId: lease.ownerId,
                ownerEpoch: lease.epoch,
                callbackFence: {
                    operationId: realFence.operationId,
                    settle: async (attempt) => {
                        const result = await realFence.settle(attempt);
                        committed = true;
                        return result;
                    },
                },
            },
            settlementLedger: {
                ...ledger,
                record: (entry) => {
                    observerCommitStates.push(committed);
                    ledger.record(entry);
                },
            },
            onToolEvent: () => observerCommitStates.push(committed),
        });
        if (bridged.execute === undefined) throw new Error('bridged tool missing execute');

        // When
        await bridged.execute({}, executionOptions('abg-order'));

        // Then
        expect(observerCommitStates).toEqual([true, true]);
        runtime.close();
    });

    it('publishes no ledger or observer state when the fence transaction rolls back', async () => {
        // Given
        const runtime = await createOperationTestRuntime();
        const registry = new ToolRegistry();
        const advertisement = registry.register(registration());
        const ledger = createAbgToolSettlementLedger();
        const forwarded: AgentEvent[] = [];
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, {
            controlEpoch: {
                dbIdentity: 'd'.repeat(64),
                sessionId: 'session-abg-rollback',
                ownerId: 'owner-abg-rollback',
                ownerEpoch: 1,
                callbackFence: {
                    operationId: 'operation-abg-rollback',
                    settle: async (attempt) => {
                        await attempt.write?.(runtime.client);
                        throw new Error('injected transaction rollback');
                    },
                },
            },
            settlementLedger: ledger,
            onToolEvent: (event) => forwarded.push(event),
        });
        if (bridged.execute === undefined) throw new Error('bridged tool missing execute');

        // When / Then
        await expect(bridged.execute({}, executionOptions('abg-rollback'))).rejects.toThrow(
            'injected transaction rollback',
        );
        expect(ledger.lookup('abg-rollback')).toBeUndefined();
        expect(forwarded).toEqual([]);
        runtime.close();
    });

    it('fails closed without a controlled settlement writer and leaves the handle unsettled', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-registry-live', 1_000);
        const registry = new ToolRegistry();
        const advertisement = registry.register(registration());
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-registry-no-writer',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['tool:no-writer'],
            nowWallMs: 1_100,
        });

        const settlement = await registry.invoke({
            toolCallId: 'no-writer',
            toolName: advertisement.name,
            advertisedVersion: advertisement.version,
            argumentsJson: '{}',
            controlEpoch: epoch(runtime, lease, 'operation-registry-no-writer'),
        });

        expect(settlement.result).toMatchObject({ status: 'failed', error: { code: 'tool_failed' } });
        expect(
            await readSessionControlOperation(
                runtime,
                lease.dbIdentity,
                lease.sessionId,
                'operation-registry-no-writer',
            ),
        ).toMatchObject({ settledHandleIds: [] });
        runtime.close();
    });
});

function registration() {
    return {
        name: 'abg-fenced-tool',
        description: 'ABG fenced tool',
        capabilityClasses: ['read'],
        parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ ok: z.literal(true) }).strict(),
        outputLimit: { maxModelOutputChars: 100 },
        execute: () => ({ ok: true as const }),
        toEvents: () => [forwardedEvent],
    };
}

function epoch(
    runtime: Parameters<typeof createSessionControlCallbackFence>[0]['runtime'],
    lease: Parameters<typeof createSessionControlCallbackFence>[0]['lease'],
    operationId: string,
) {
    return {
        dbIdentity: lease.dbIdentity,
        sessionId: lease.sessionId,
        ownerId: lease.ownerId,
        ownerEpoch: lease.epoch,
        callbackFence: createSessionControlCallbackFence({ runtime, lease, operationId, nowWallMs: () => 2_100 }),
    };
}

function executionOptions(toolCallId: string) {
    return { toolCallId, messages: [] as ModelMessage[], abortSignal: new AbortController().signal };
}
