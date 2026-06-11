import { AgentRuntime, type ProviderAdapter } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createCliRuntimeOptions } from './cli-runtime-options.js';

describe('createCliRuntimeOptions', () => {
    it('surfaces approval-required JSON events for effectful non-interactive permissions', async () => {
        const runtime = new AgentRuntime(createCliRuntimeOptions({ provider: unusedProvider }));
        const events: AgentEvent[] = [];
        const unsubscribe = runtime.onEvent((event) => {
            events.push(event);
        });

        await runtime.start();
        await expect(
            runtime.requestPermission({
                id: 'permission_command_run',
                action: 'command.run',
                reason: 'run command: pnpm test',
            }),
        ).rejects.toMatchObject({ code: 'approval_required' });
        unsubscribe();

        const jsonLines = events.map((event) => JSON.stringify(event)).join('\n');
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['permission.requested', 'approval.requested', 'approval.blocked']),
        );
        expect(jsonLines).toContain('"policyDecision":"requires_approval"');
        expect(jsonLines).toContain('"state":"cancelled"');
        expect(jsonLines).toContain('"subject":{"kind":"tool","id":"command.run"}');
    });
});

const unusedProvider: ProviderAdapter = {
    async *streamTurn(request) {
        yield {
            kind: 'response_failed',
            requestId: request.requestId,
            sequence: 1,
            error: {
                code: 'unknown',
                message: 'unused provider should not be called by permission tests',
                retryable: false,
            },
        };
    },
};
