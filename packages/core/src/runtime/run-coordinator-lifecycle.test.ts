import { describe, expect, it, vi } from 'vitest';
import { finalizeProviderTurnResult } from './run-coordinator-lifecycle.js';

describe('run coordinator lifecycle reason safety', () => {
    it('redacts and bounds failed reasons before durable emission and return', async () => {
        const appendRunEvent = vi.fn(async () => undefined);

        const result = await finalizeProviderTurnResult({
            result: {
                status: 'failed',
                reason: `Bearer secret-token-value ${'x'.repeat(5000)}`,
                errorCode: 'provider_timeout',
            },
            command: 'run',
            runId: 'run_safe_reason',
            turns: 1,
            appendRunEvent,
        });

        expect(result?.reason).not.toContain('secret-token-value');
        expect(result?.reason).toContain('[REDACTED_CREDENTIAL]');
        expect(result?.reason).toHaveLength(4096);
        expect(appendRunEvent).toHaveBeenCalledWith(
            'run.failed',
            'run',
            'failed',
            result?.reason,
            expect.objectContaining({ reason: result?.reason }),
        );
    });
});
