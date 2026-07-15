import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SessionControlEpoch } from '../../../runtime/session-control-cancellation';
import { ToolRegistry } from '../../../tools/tool-registry';
import type { ToolExecutionContext } from '../../../tools/tool-registry-types';
import { bridgeAdvertisementToAiSdk } from './abg-tool-bridge';

const CONTROL_EPOCH: SessionControlEpoch = {
    dbIdentity: 'd'.repeat(64),
    sessionId: 'session-model',
    ownerId: 'owner-model',
    ownerEpoch: 5,
};

describe('LLM actor cancellation propagation', () => {
    it('threads the model tool-call signal and owner epoch into registry execution', async () => {
        const registry = new ToolRegistry();
        let observed: ToolExecutionContext | undefined;
        const advertisement = registry.register({
            name: 'observe',
            description: 'observe context',
            capabilityClasses: ['read'],
            parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
            inputSchema: z.object({}).strict(),
            outputSchema: z.object({ ok: z.literal(true) }).strict(),
            outputLimit: { maxModelOutputChars: 100 },
            execute: (_input, context) => {
                observed = context;
                return { ok: true as const };
            },
        });
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, { controlEpoch: CONTROL_EPOCH });
        if (bridged.execute === undefined) throw new Error('bridged tool is missing execute');
        const controller = new AbortController();

        await bridged.execute(
            {},
            { toolCallId: 'model-tool-call', messages: [] as ModelMessage[], abortSignal: controller.signal },
        );

        expect(observed?.signal).toBe(controller.signal);
        expect(observed?.controlEpoch).toEqual(CONTROL_EPOCH);
    });
});
