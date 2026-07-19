import { describe, expect, it } from 'vitest';
import { createDeferred, scriptedInput } from './coding-agent-built-dist-smoke-support';

describe('coding-agent built-dist smoke support', () => {
    it('waits for every indexed gate before yielding its scripted event', async () => {
        const firstGate = createDeferred();
        const secondGate = createDeferred();
        const input = scriptedInput(
            [
                { type: 'line', value: 'prompt' },
                { type: 'line', value: 'always' },
                { type: 'line', value: 'once' },
            ],
            [
                { beforeIndex: 1, until: firstGate.promise },
                { beforeIndex: 2, until: secondGate.promise },
            ],
        );

        await expect(input.read()).resolves.toEqual({ type: 'line', value: 'prompt' });
        const firstApproval = input.read();
        let firstApprovalSettled = false;
        const observedFirstApproval = firstApproval.then((event) => {
            firstApprovalSettled = true;
            return event;
        });
        await Promise.resolve();
        expect(firstApprovalSettled).toBe(false);
        firstGate.resolve();
        await expect(observedFirstApproval).resolves.toEqual({ type: 'line', value: 'always' });

        const secondApproval = input.read();
        let secondApprovalSettled = false;
        const observedSecondApproval = secondApproval.then((event) => {
            secondApprovalSettled = true;
            return event;
        });
        await Promise.resolve();
        expect(secondApprovalSettled).toBe(false);
        secondGate.resolve();
        await expect(observedSecondApproval).resolves.toEqual({ type: 'line', value: 'once' });
    });
});
