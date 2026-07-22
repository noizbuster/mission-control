import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../tools/tool-registry';
import {
    AbgToolBridgeError,
    bridgeAdvertisementToAiSdk,
    createAbgToolSettlementLedger,
    createProposalOnlyToolBridge,
    type PolicyGateFn,
} from './abg-tool-bridge';
import { echoRegistration } from './llm-actor-node-test-support';

describe('abg-tool-bridge', () => {
    it('defers registry execution until the graph settles a captured proposal', async () => {
        let executions = 0;
        const registry = new ToolRegistry();
        const advertisement = registry.register({
            ...echoRegistration,
            execute: async (input) => {
                executions += 1;
                return { text: input.text };
            },
        });
        const ledger = createAbgToolSettlementLedger();

        const bridge = createProposalOnlyToolBridge(registry, [advertisement], { settlementLedger: ledger });

        expect(Object.values(bridge.tools).at(0)?.execute).toBeUndefined();
        expect(executions).toBe(0);

        const settled = await bridge.execute(
            [{ toolCallId: 'c_deferred', toolName: 'echo', argumentsJson: '{"text":"hi"}' }],
            new AbortController().signal,
        );

        expect(executions).toBe(1);
        expect(settled).toHaveLength(1);
        expect(settled[0]?.settlement).toMatchObject({ toolCallId: 'c_deferred', status: 'completed' });
        expect(ledger.lookup('c_deferred')?.status).toBe('completed');
    });

    it('settles every proposal when one registered tool throws unexpectedly', async () => {
        const registry = new ToolRegistry();
        const crashing = registry.register({
            ...echoRegistration,
            name: 'crash',
            execute: async () => {
                throw new Error('unexpected tool failure');
            },
        });
        const succeeding = registry.register(echoRegistration);
        const bridge = createProposalOnlyToolBridge(registry, [crashing, succeeding]);

        const settled = await bridge.execute(
            [
                { toolCallId: 'c_crash', toolName: 'crash', argumentsJson: '{"text":"boom"}' },
                { toolCallId: 'c_echo', toolName: 'echo', argumentsJson: '{"text":"ok"}' },
            ],
            new AbortController().signal,
        );

        expect(settled).toEqual([
            expect.objectContaining({
                settlement: expect.objectContaining({
                    toolCallId: 'c_crash',
                    status: 'failed',
                    error: expect.objectContaining({ code: 'tool_failed', retryable: false }),
                }),
            }),
            expect.objectContaining({
                settlement: expect.objectContaining({ toolCallId: 'c_echo', status: 'completed' }),
            }),
        ]);
    });

    it('surfaces failed-settlement errors to the model instead of "" (review fix #2)', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register(echoRegistration);
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, {});
        if (bridged.execute === undefined) {
            throw new Error('bridged tool is missing execute');
        }
        const result = await bridged.execute(
            { wrong: 1 },
            {
                toolCallId: 'c1',
                messages: [] as ModelMessage[],
                abortSignal: new AbortController().signal,
                context: {} as never,
            },
        );
        expect(result).toContain('failed (schema_invalid)');
    });

    it('rejects a malformed parametersJsonSchema at bridge build time (review fix #5)', () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register({
            ...echoRegistration,
            name: 'bad-schema',
            parametersJsonSchema: { notASchema: true },
        });
        expect(() => bridgeAdvertisementToAiSdk(registry, advertisement, {})).toThrow(AbgToolBridgeError);
    });

    it('records the settlement outcome in the ledger (status/output/error parity for the tool emits)', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register(echoRegistration);
        const ledger = createAbgToolSettlementLedger();
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, { settlementLedger: ledger });
        if (bridged.execute === undefined) throw new Error('bridged tool missing execute');

        await bridged.execute(
            { text: 'hi' },
            {
                toolCallId: 'c_ok',
                messages: [] as ModelMessage[],
                abortSignal: new AbortController().signal,
                context: {} as never,
            },
        );
        const completed = ledger.lookup('c_ok');
        expect(completed?.status).toBe('completed');
        expect(completed?.output).not.toBeUndefined();

        await bridged.execute(
            { wrong: 1 },
            {
                toolCallId: 'c_bad',
                messages: [] as ModelMessage[],
                abortSignal: new AbortController().signal,
                context: {} as never,
            },
        );
        const failed = ledger.lookup('c_bad');
        expect(failed?.status).toBe('failed');
        expect(failed?.error?.code).toBe('schema_invalid');
    });

    it('records a denied policy gate as a failed settlement so the emit is not mislabeled completed', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register(echoRegistration);
        const ledger = createAbgToolSettlementLedger();
        const deny: PolicyGateFn = async () => ({ allowed: false, reason: 'not permitted' });
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, {
            policyGate: deny,
            settlementLedger: ledger,
        });
        if (bridged.execute === undefined) throw new Error('bridged tool missing execute');

        const result = await bridged.execute(
            { text: 'hi' },
            {
                toolCallId: 'c_deny',
                messages: [] as ModelMessage[],
                abortSignal: new AbortController().signal,
                context: {} as never,
            },
        );
        expect(result).toContain('BLOCKED');
        const entry = ledger.lookup('c_deny');
        expect(entry?.status).toBe('failed');
        expect(entry?.error?.code).toBe('unknown');
    });
});
