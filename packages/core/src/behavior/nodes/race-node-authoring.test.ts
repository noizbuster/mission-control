import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { collectSignals } from '../composite-node-test-helpers';
import { MAX_RACE_CLEANUP_TIMEOUT_MS } from './race-cleanup';
import { createRaceNodeRunner, MAX_RACE_CHILDREN } from './race-node';
import { raceNode, runContext, validWinner } from './race-node-test-support';

describe('Race authoring bounds', () => {
    it('rejects child count above the Race cap before starting a branch', async () => {
        let runCount = 0;
        const runner = createRaceNodeRunner(() => {
            runCount += 1;
            return validWinner();
        });

        const signals = await collectSignals(
            runner(
                raceNode(Array.from({ length: MAX_RACE_CHILDREN + 1 }, (_, index) => `child-${index}`)),
                runContext(),
            ),
        );

        expect(runCount).toBe(0);
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'race',
            error: {
                code: 'race_child_limit_exceeded',
                childCount: MAX_RACE_CHILDREN + 1,
                maxChildren: MAX_RACE_CHILDREN,
            },
        });
    });

    it('rejects cleanupTimeoutMs above thirty seconds before starting a branch', async () => {
        let runCount = 0;
        const runner = createRaceNodeRunner(() => {
            runCount += 1;
            return validWinner();
        });

        const signals = await collectSignals(
            runner(raceNode(['winner'], MAX_RACE_CLEANUP_TIMEOUT_MS + 1), runContext()),
        );

        expect(runCount).toBe(0);
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'race',
            error: {
                code: 'race_cleanup_timeout_invalid',
                cleanupTimeoutMs: MAX_RACE_CLEANUP_TIMEOUT_MS + 1,
                maxCleanupTimeoutMs: MAX_RACE_CLEANUP_TIMEOUT_MS,
            },
        });
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['fractional', 1.5],
        ['non-number', '5000'],
    ])('rejects %s cleanupTimeoutMs before starting a branch', async (_label, cleanupTimeoutMs) => {
        let runCount = 0;
        const runner = createRaceNodeRunner(() => {
            runCount += 1;
            return validWinner();
        });
        const node: AbgNodeSpec = {
            id: 'race',
            kind: 'race',
            children: ['winner'],
            config: { cleanupTimeoutMs },
        };

        const signals: readonly AbgSignal[] = await collectSignals(runner(node, runContext()));

        expect(runCount).toBe(0);
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'race',
            error: {
                code: 'race_cleanup_timeout_invalid',
                cleanupTimeoutMs,
                maxCleanupTimeoutMs: MAX_RACE_CLEANUP_TIMEOUT_MS,
            },
        });
    });
});
