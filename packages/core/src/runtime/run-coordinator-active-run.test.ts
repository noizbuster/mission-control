import { describe, expect, it } from 'vitest';
import { interruptActiveRun } from './run-coordinator-active-run.js';

describe('run coordinator interrupt reason safety', () => {
    it('redacts and bounds interrupt reasons before durable emission', async () => {
        let emittedReason: string | undefined;

        await interruptActiveRun({
            activeRun: undefined,
            appendRunEvent: async (_type, _command, _state, _message, metadata) => {
                emittedReason = metadata.reason;
            },
            reason: `Bearer secret-token-value ${'x'.repeat(5000)}`,
        });

        expect(emittedReason).not.toContain('secret-token-value');
        expect(emittedReason).toContain('[REDACTED_CREDENTIAL]');
        expect(emittedReason).toHaveLength(4096);
    });
});
